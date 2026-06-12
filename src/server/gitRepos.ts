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
} from "./marketplace.js";
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

function git(repoRoot: string, args: string[], timeout = 120_000) {
  return execFileAsync("git", ["-C", repoRoot, ...args], { timeout });
}

function assertSafeGitValue(value: string | null, what: string): void {
  if (value?.startsWith("-")) {
    throw new Error(`Invalid ${what}: must not start with "-"`);
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
  return {
    userId,
    name: record.name,
    repo: record.repo,
    branch: record.branch,
    token: store.getGitToken(userId),
    config,
  };
}

export function gitRepoContextFromRecord(
  store: Store,
  record: GitRepository,
  config: AppConfig,
): GitRepoContext {
  return {
    userId: record.userId,
    name: record.name,
    repo: record.repo,
    branch: record.branch,
    token: store.getGitToken(record.userId),
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

async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

async function dirtyGitRepoPaths(repoRoot: string): Promise<string[]> {
  const { stdout } = await git(repoRoot, ["status", "--porcelain", "-uall"]);
  return stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
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
 * Ensure the user-registered repo has a local full clone under dataDir. When
 * `sync` is true, fetch and fast-forward; otherwise preserve local work.
 */
export async function ensureGitRepoClone(
  ctx: GitRepoContext,
  options: { sync?: boolean } = {},
): Promise<string> {
  assertSafeGitValue(ctx.repo, "repo");
  assertSafeGitValue(ctx.branch, "branch");
  const repoRoot = gitRepoClonePath(ctx.userId, ctx.name, ctx.config);
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  assertSafeGitValue(url, "repo");
  const auth = gitAuthArgs(url, ctx.token ?? undefined);

  if (await pathExists(path.join(repoRoot, ".git"))) {
    const existing = await remoteUrl(repoRoot);
    if (existing && existing !== url) {
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
    await execFileAsync("git", args, { timeout: 180_000 });
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
    dirty: await dirtyGitRepoPaths(repoRoot),
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
  const repoRoot = await ensureGitRepoClone(ctx);
  const pathArgs = normalizeRepoPaths(repoRoot, paths);
  const name = identity.name.startsWith("-") ? "noah-almighty" : identity.name;
  const email = identity.email.startsWith("-") ? "avatar@noah-almighty.local" : identity.email;
  await git(repoRoot, ["config", "user.name", name]);
  await git(repoRoot, ["config", "user.email", email]);
  await git(repoRoot, pathArgs.length ? ["add", "-A", "--", ...pathArgs] : ["add", "-A"]);
  if (!(await hasStagedChanges(repoRoot))) {
    return false;
  }
  await git(repoRoot, ["commit", "-m", message.trim() || "Update repository"]);
  return true;
}

export async function pushGitRepo(ctx: GitRepoContext): Promise<string> {
  const repoRoot = await ensureGitRepoClone(ctx);
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  const auth = gitAuthArgs(url, ctx.token ?? undefined);
  const rawBranch = ctx.branch || (await currentBranch(repoRoot)) || "HEAD";
  const branch = rawBranch.startsWith("-") ? "HEAD" : rawBranch;
  await git(repoRoot, [...auth, "push", "origin", `HEAD:${branch}`]);
  return branch;
}
