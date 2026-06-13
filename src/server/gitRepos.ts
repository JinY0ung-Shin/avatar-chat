import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig, GitRepository } from "./types.js";
import type { Store } from "./store.js";
import {
  gitAuthArgs,
  marketplaceCloneUrl,
  pathExists,
  sanitizeName,
  scrubGitError,
} from "./marketplace.js";
import { tokenForGitUrl } from "./gitCredentials.js";
import { withRepoLock } from "./gitMutex.js";
import { safeIdentity, safePushBranch } from "./repoGitGuards.js";
import { git, currentBranch, dirtyPaths } from "./repoGitCore.js";
import logger from "./logger.js";
import {
  deleteFile,
  listTree,
  readFile,
  resolveInRepo,
  writeFile,
} from "./knowledgeRepo.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 60_000;

export interface GitRepoContext {
  userId: string;
  name: string;
  repo: string;
  branch: string | null;
  token: string | null;
  config: AppConfig;
}

export interface GitRepoStatus {
  name: string;
  repo: string;
  branch: string | null;
  cloned: boolean;
  head: string | null;
  dirty: string[];
  ahead: number | null;
  behind: number | null;
}

// `scheme::` remote-helper syntax (e.g. `ext::sh -c …`, `fd::`) makes git run an
// arbitrary transport helper — a command-execution vector. The pattern is a
// run of scheme chars followed by `::`; no legitimate branch, path, repo
// shorthand, or https/ssh URL we accept contains `::`, so rejecting it is safe
// across every value kind assertSafeGitValue guards (sec-03).
const REMOTE_HELPER_RE = /^[a-z0-9+.-]*::/i;

function assertSafeGitValue(value: string | null, what: string): void {
  if (value == null) {
    return;
  }
  if (value.startsWith("-")) {
    throw new Error(`Invalid ${what}: must not start with "-"`);
  }
  if (REMOTE_HELPER_RE.test(value)) {
    throw new Error(`Invalid ${what}: remote-helper syntax ("<scheme>::") is not allowed`);
  }
}

export function normalizeGitRepoName(name: string): string {
  return sanitizeName(name.trim()).toLowerCase().replace(/^-+|-+$/g, "") || "repo";
}

export function defaultGitRepoName(repo: string): string {
  const withoutSlash = repo.trim().replace(/\/+$/g, "");
  const leaf = withoutSlash.split(/[/:]/).pop() || "repo";
  return normalizeGitRepoName(leaf.replace(/\.git$/i, ""));
}

export function gitRepoClonePath(userId: string, name: string, config: AppConfig): string {
  return path.join(config.dataDir, "git-repos", sanitizeName(userId), normalizeGitRepoName(name));
}

export function gitRepoContextFor(
  store: Store,
  userId: string,
  name: string,
  config: AppConfig,
): GitRepoContext | null {
  const record = store.getGitRepo(userId, normalizeGitRepoName(name));
  if (!record) {
    return null;
  }
  const url = marketplaceCloneUrl(record.repo, config.githubHost);
  return {
    userId,
    name: record.name,
    repo: record.repo,
    branch: record.branch,
    token: tokenForGitUrl(url, config, store.getGitTokens(userId)) ?? null,
    config,
  };
}

export function gitRepoContextFromRecord(
  store: Store,
  record: GitRepository,
  config: AppConfig,
): GitRepoContext {
  const url = marketplaceCloneUrl(record.repo, config.githubHost);
  return {
    userId: record.userId,
    name: record.name,
    repo: record.repo,
    branch: record.branch,
    token: tokenForGitUrl(url, config, store.getGitTokens(record.userId)) ?? null,
    config,
  };
}

async function remoteUrl(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["remote", "get-url", "origin"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function checkoutBranch(repoRoot: string, branch: string): Promise<void> {
  assertSafeGitValue(branch, "branch");
  try {
    await git(repoRoot, ["checkout", branch]);
  } catch {
    await git(repoRoot, ["checkout", "-B", branch, `origin/${branch}`]);
  }
}

async function pullFastForward(ctx: GitRepoContext, repoRoot: string, url: string): Promise<void> {
  const auth = gitAuthArgs(url, ctx.token ?? undefined);
  await git(repoRoot, [...auth, "fetch", "--prune", "--tags", "origin"]);
  if (ctx.branch) {
    await checkoutBranch(repoRoot, ctx.branch);
    await git(repoRoot, ["merge", "--ff-only", `origin/${ctx.branch}`]);
    return;
  }
  await git(repoRoot, [...auth, "pull", "--ff-only"]);
}

/**
 * True when the clone has commits not present on ANY upstream — i.e. local work
 * that a `rm -rf` would silently destroy. Uses the configured-branch upstream
 * when set, else the tracking upstream of HEAD; returns false when there's no
 * upstream to compare against (can't prove unpushed work, so don't block).
 */
async function hasUnpushedCommits(repoRoot: string, branch: string | null): Promise<boolean> {
  const upstream = branch ? `origin/${branch}` : "@{upstream}";
  try {
    const { stdout } = await git(repoRoot, ["rev-list", `${upstream}..HEAD`, "--count"]);
    return Number.parseInt(stdout.trim(), 10) > 0;
  } catch {
    // No such upstream / detached with no tracking ref: can't determine, and a
    // freshly-cloned mismatch typically has none. Treat as "no unpushed work".
    return false;
  }
}

/**
 * Ensure the user-registered repo has a local full clone under dataDir. When
 * `sync` is true, fetch and fast-forward; otherwise preserve local work.
 * Serialized per clone path so concurrent turns/tools can't interleave
 * clone/fetch/checkout on one working tree (git-02).
 */
export async function ensureGitRepoClone(
  ctx: GitRepoContext,
  options: { sync?: boolean } = {},
): Promise<string> {
  const repoRoot = gitRepoClonePath(ctx.userId, ctx.name, ctx.config);
  return withRepoLock(repoRoot, () => ensureGitRepoCloneLocked(ctx, repoRoot, options));
}

/**
 * Clone/fetch body of ensureGitRepoClone WITHOUT the per-path lock. Callers that
 * already hold the lock for `repoRoot` (commit/push) call this directly so they
 * never re-enter `withRepoLock` for the same key (deadlock-free, see gitMutex).
 */
async function ensureGitRepoCloneLocked(
  ctx: GitRepoContext,
  repoRoot: string,
  options: { sync?: boolean } = {},
): Promise<string> {
  assertSafeGitValue(ctx.repo, "repo");
  assertSafeGitValue(ctx.branch, "branch");
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  assertSafeGitValue(url, "repo");
  const auth = gitAuthArgs(url, ctx.token ?? undefined);

  if (await pathExists(path.join(repoRoot, ".git"))) {
    const existing = await remoteUrl(repoRoot);
    if (existing && existing !== url) {
      // The remote URL changed. Blowing the clone away silently destroys any
      // committed-but-unpushed work, so refuse when such work exists; only
      // auto-remove a clone with nothing unpushed (git-07).
      if (await hasUnpushedCommits(repoRoot, ctx.branch)) {
        throw new Error(
          scrubGitError(
            `로컬 클론의 원격 주소가 등록된 저장소와 다른데(기존: ${existing}), 푸시되지 않은 커밋이 있어 자동으로 교체하지 않았습니다. 변경사항을 푸시하거나 백업한 뒤 다시 시도해 주세요.`,
          ),
        );
      }
      logger.warn(
        { userId: ctx.userId, name: ctx.name, existing, url },
        "git repo clone remote URL changed; removing clone (no unpushed commits)",
      );
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  }

  if (!(await pathExists(path.join(repoRoot, ".git")))) {
    await fs.mkdir(path.dirname(repoRoot), { recursive: true });
    const args = [...auth, "clone"];
    if (ctx.branch) {
      args.push("--branch", ctx.branch);
    }
    args.push("--", url, repoRoot);
    try {
      await execFileAsync("git", args, { timeout: 180_000 });
    } catch (error) {
      // Remove a half-initialized clone so the next run re-clones cleanly (git-06).
      await fs.rm(repoRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return repoRoot;
  }

  if (options.sync) {
    await pullFastForward(ctx, repoRoot, url);
  }
  return repoRoot;
}

export async function removeGitRepoClone(ctx: GitRepoContext): Promise<void> {
  await fs.rm(gitRepoClonePath(ctx.userId, ctx.name, ctx.config), { recursive: true, force: true });
}

export async function gitRepoStatus(ctx: GitRepoContext): Promise<GitRepoStatus> {
  const repoRoot = gitRepoClonePath(ctx.userId, ctx.name, ctx.config);
  const cloned = await pathExists(path.join(repoRoot, ".git"));
  if (!cloned) {
    return {
      name: ctx.name,
      repo: ctx.repo,
      branch: ctx.branch,
      cloned: false,
      head: null,
      dirty: [],
      ahead: null,
      behind: null,
    };
  }
  let head: string | null = null;
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "--short", "HEAD"]);
    head = stdout.trim() || null;
  } catch {
    head = null;
  }
  let ahead: number | null = null;
  let behind: number | null = null;
  try {
    const { stdout } = await git(repoRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/).map(Number);
    behind = Number.isFinite(behindRaw) ? behindRaw : null;
    ahead = Number.isFinite(aheadRaw) ? aheadRaw : null;
  } catch {
    /* no upstream */
  }
  return {
    name: ctx.name,
    repo: ctx.repo,
    branch: await currentBranch(repoRoot),
    cloned: true,
    head,
    dirty: await dirtyPaths(repoRoot, ["-uall"]),
    ahead,
    behind,
  };
}

function normalizeRepoPaths(repoRoot: string, paths?: string[]): string[] {
  if (!paths || paths.length === 0) {
    return [];
  }
  return paths.map((relPath) => {
    const lexical = resolveInRepo(repoRoot, relPath);
    if (!lexical || lexical === repoRoot) {
      throw new Error("INVALID_PATH");
    }
    return path.relative(repoRoot, lexical).split(path.sep).join("/");
  });
}

export async function listGitRepoTree(ctx: GitRepoContext) {
  const repoRoot = await ensureGitRepoClone(ctx);
  return listTree(repoRoot);
}

export async function readGitRepoFile(ctx: GitRepoContext, relPath: string): Promise<string> {
  const repoRoot = await ensureGitRepoClone(ctx);
  return readFile(repoRoot, relPath);
}

export async function writeGitRepoFile(ctx: GitRepoContext, relPath: string, content: string): Promise<void> {
  const repoRoot = await ensureGitRepoClone(ctx);
  await writeFile(repoRoot, relPath, content);
}

export async function deleteGitRepoFile(ctx: GitRepoContext, relPath: string): Promise<void> {
  const repoRoot = await ensureGitRepoClone(ctx);
  await deleteFile(repoRoot, relPath);
}

export async function gitRepoDiff(ctx: GitRepoContext, paths?: string[]): Promise<string> {
  const repoRoot = await ensureGitRepoClone(ctx);
  const pathArgs = normalizeRepoPaths(repoRoot, paths);
  const { stdout } = await git(repoRoot, ["diff", "--no-ext-diff", "--", ...pathArgs]);
  return stdout.length > MAX_DIFF_CHARS
    ? `${stdout.slice(0, MAX_DIFF_CHARS)}\n\n[truncated ${stdout.length - MAX_DIFF_CHARS} chars]`
    : stdout;
}

async function hasStagedChanges(repoRoot: string): Promise<boolean> {
  try {
    await git(repoRoot, ["diff", "--cached", "--quiet"]);
    return false;
  } catch (error) {
    const err = error as { code?: unknown };
    if (err.code === 1) {
      return true;
    }
    throw error;
  }
}

export async function commitGitRepo(
  ctx: GitRepoContext,
  message: string,
  identity: { name: string; email: string },
  paths?: string[],
): Promise<boolean> {
  const repoRoot = gitRepoClonePath(ctx.userId, ctx.name, ctx.config);
  // One lock for the whole ensure+add+commit so the staged state can't be
  // disturbed mid-commit by a concurrent op on the same clone (git-02). Use the
  // lock-free clone internal to avoid re-entering the same key.
  return withRepoLock(repoRoot, async () => {
    await ensureGitRepoCloneLocked(ctx, repoRoot);
    const pathArgs = normalizeRepoPaths(repoRoot, paths);
    const { name, email } = safeIdentity(identity);
    await git(repoRoot, ["config", "user.name", name]);
    await git(repoRoot, ["config", "user.email", email]);
    await git(repoRoot, pathArgs.length ? ["add", "-A", "--", ...pathArgs] : ["add", "-A"]);
    if (!(await hasStagedChanges(repoRoot))) {
      return false;
    }
    await git(repoRoot, ["commit", "-m", message.trim() || "Update repository"]);
    return true;
  });
}

export async function pushGitRepo(ctx: GitRepoContext): Promise<string> {
  const repoRoot = gitRepoClonePath(ctx.userId, ctx.name, ctx.config);
  // Serialize the ensure+push against concurrent ops on the same clone (git-02).
  return withRepoLock(repoRoot, async () => {
    await ensureGitRepoCloneLocked(ctx, repoRoot);
    const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
    const auth = gitAuthArgs(url, ctx.token ?? undefined);
    const branch = safePushBranch(ctx.branch || (await currentBranch(repoRoot)) || "HEAD");
    await git(repoRoot, [...auth, "push", "origin", `HEAD:${branch}`]);
    return branch;
  });
}
