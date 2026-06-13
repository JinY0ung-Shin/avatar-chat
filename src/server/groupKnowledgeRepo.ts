import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import logger from "./logger.js";
import { gitAuthArgs, marketplaceCloneUrl, pathExists, sanitizeName, scrubGitError } from "./marketplace.js";
import { tokenForGitUrl, type GitTokenSet } from "./gitCredentials.js";
import { withRepoLock } from "./gitMutex.js";
import type { AppConfig } from "./types.js";
import type { Store } from "./store.js";

const execFileAsync = promisify(execFile);

// The GROUP knowledge repo is the group analogue of a user's personal knowledge
// repo (see knowledgeRepo.ts): a FULL clone at ${dataDir}/group-knowledge/<groupId>
// that all group members' avatars load skills from, and that group admins edit
// via the mcp__group_repo__* tools. The repo-relative file operations (listTree,
// readFile, writeFile, scaffoldSkill, writeRepoTemplate) are reused as-is from
// knowledgeRepo.ts — only clone/commit/push and context resolution are group-scoped.

/**
 * Per-conversation context the group knowledge-repo operations act within. The
 * `token` is resolved from the ACTING user (the member loading skills, or the
 * group admin committing) — the group repo carries no token of its own.
 */
export interface GroupKnowledgeRepoContext {
  groupId: string;
  /** For attributing loaded skills to the right group in the UI. */
  groupName?: string;
  repo: string;
  branch: string | null;
  // INTERNAL git token of the acting user; also the "token configured?" gate in
  // groupRepoTools.ts (`if (!c.token)`), so it stays a nullable string.
  token: string | null;
  // EXTERNAL git token (GITHUB_TOKEN) of the acting user, for a github.com repo
  // on a GHES deployment (git-05). Routed per-URL via `tokenForGitUrl`.
  externalToken?: string | null;
  config: AppConfig;
  /** Subset of plugin names to load when the repo is a marketplace; null = all. */
  selected: string[] | null;
}

/** Host-aware token set for a group context (acting user's internal + external). */
function repoTokens(ctx: GroupKnowledgeRepoContext): GitTokenSet {
  return { internal: ctx.token, external: ctx.externalToken ?? null };
}

/** On-disk clone path for a group's shared knowledge-repo working tree. */
export function groupKnowledgeClonePath(groupId: string, config: AppConfig): string {
  return path.join(config.dataDir, "group-knowledge", sanitizeName(groupId));
}

function git(repoRoot: string, args: string[], timeout = 120_000) {
  return execFileAsync("git", ["-C", repoRoot, ...args], { timeout });
}

async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const name = stdout.trim();
    return name && name !== "HEAD" ? name : null;
  } catch {
    return null;
  }
}

/** Relative paths with uncommitted changes (porcelain). */
async function dirtyPaths(repoRoot: string): Promise<string[]> {
  const { stdout } = await git(repoRoot, ["status", "--porcelain"]);
  return stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * Ensure the group's knowledge repo is cloned (full clone) and up to date on the
 * configured branch. Returns the working-tree path. Mirrors `ensureClone` in
 * knowledgeRepo.ts but keyed by groupId — including the git-01 unpushed-commit
 * guard (ff-only, never hard-reset away local commits) and the git-02 per-clone
 * serialization (the group clone is the hottest shared tree — every member's
 * turn hits it while admins commit/push).
 */
export async function ensureGroupClone(ctx: GroupKnowledgeRepoContext): Promise<string> {
  const repoRoot = groupKnowledgeClonePath(ctx.groupId, ctx.config);
  return withRepoLock(repoRoot, () => ensureGroupCloneLocked(ctx, repoRoot));
}

async function ensureGroupCloneLocked(
  ctx: GroupKnowledgeRepoContext,
  repoRoot: string,
): Promise<string> {
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  // Reject values git would read as options (e.g. `--upload-pack=…` → RCE).
  if (url.startsWith("-") || (ctx.branch && ctx.branch.startsWith("-"))) {
    throw new Error("Invalid repo or branch");
  }
  const auth = gitAuthArgs(url, tokenForGitUrl(url, ctx.config, repoTokens(ctx)));

  if (await pathExists(path.join(repoRoot, ".git"))) {
    await git(repoRoot, [...auth, "fetch", "--prune", "origin"]);
  } else {
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
    logger.info({ groupId: ctx.groupId, repo: ctx.repo }, "group knowledge repo cloned");
  }

  const branch = ctx.branch || (await currentBranch(repoRoot));
  if (branch && !branch.startsWith("-")) {
    await alignBranch(repoRoot, branch, { groupId: ctx.groupId, repo: ctx.repo });
  }
  return repoRoot;
}

/**
 * Move onto `branch`@origin without discarding unpushed commits (git-01): only
 * `checkout -B` (which would drop local commits) when HEAD is NOT ahead of
 * origin/<branch>; otherwise merge --ff-only and, if that can't fast-forward,
 * leave the local branch as-is with a warning. Mirrors knowledgeRepo.ts.
 */
async function alignBranch(
  repoRoot: string,
  branch: string,
  log: Record<string, unknown>,
): Promise<void> {
  const ahead = await aheadOfRemote(repoRoot, branch);
  if (ahead === null) {
    return; // origin/<branch> absent (fresh repo) — keep the clone's HEAD.
  }
  if (ahead === 0) {
    try {
      await git(repoRoot, ["checkout", "-B", branch, `origin/${branch}`]);
    } catch {
      /* stay put on an edge state */
    }
    return;
  }
  try {
    await git(repoRoot, ["checkout", branch]);
    await git(repoRoot, ["merge", "--ff-only", `origin/${branch}`]);
  } catch (error) {
    logger.warn(
      { ...log, branch, ahead, error: scrubGitError(error) },
      "group knowledge repo has unpushed commits that can't fast-forward; leaving local branch as-is",
    );
  }
}

/**
 * Count commits on local HEAD not yet on origin/<branch>. 0 = up to date/behind,
 * >0 = ahead, null = origin/<branch> doesn't exist. Mirrors knowledgeRepo.ts.
 */
async function aheadOfRemote(repoRoot: string, branch: string): Promise<number | null> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]);
  } catch {
    return null;
  }
  try {
    const { stdout } = await git(repoRoot, ["rev-list", `origin/${branch}..HEAD`, "--count"]);
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Restore every tracked `.mcp.json` to its committed state before push, undoing
 * the runtime `stripManagedMcpServers` edit so it never gets committed (mirrors
 * knowledgeRepo.ts `restoreTrackedMcpJson`). Best-effort.
 */
async function restoreTrackedMcpJson(repoRoot: string): Promise<void> {
  let tracked: string[];
  try {
    const { stdout } = await git(repoRoot, ["ls-files", "-z", "*.mcp.json"]);
    tracked = stdout.split("\0").filter(Boolean);
  } catch {
    return;
  }
  if (tracked.length === 0) {
    return;
  }
  try {
    await git(repoRoot, ["checkout", "HEAD", "--", ...tracked]);
  } catch {
    /* best-effort */
  }
}

/**
 * Stage all changes, commit with the actor's identity, and push to the group
 * repo's branch. Returns false (no commit) when the tree is clean. Throws on git
 * failure so the caller can surface the detail.
 */
export async function groupCommitAndPush(
  ctx: GroupKnowledgeRepoContext,
  message: string,
  identity: { name: string; email: string },
): Promise<boolean> {
  const repoRoot = groupKnowledgeClonePath(ctx.groupId, ctx.config);
  // Serialize the add/commit/push against concurrent ensureGroupClone or other
  // commits on the shared group tree (git-02). Same key, never nested.
  return withRepoLock(repoRoot, () => groupCommitAndPushLocked(ctx, repoRoot, message, identity));
}

async function groupCommitAndPushLocked(
  ctx: GroupKnowledgeRepoContext,
  repoRoot: string,
  message: string,
  identity: { name: string; email: string },
): Promise<boolean> {
  if (!(await pathExists(path.join(repoRoot, ".git")))) {
    throw new Error("NOT_CLONED");
  }
  const name = identity.name.startsWith("-") ? "noah-almighty" : identity.name;
  const email = identity.email.startsWith("-") ? "avatar@noah-almighty.local" : identity.email;
  await git(repoRoot, ["config", "user.name", name]);
  await git(repoRoot, ["config", "user.email", email]);
  await restoreTrackedMcpJson(repoRoot);
  await git(repoRoot, ["add", "-A"]);
  if ((await dirtyPaths(repoRoot)).length === 0) {
    return false;
  }
  const commitMsg = message.trim() || "Update group knowledge repo";
  await git(repoRoot, ["commit", "-m", commitMsg]);

  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  const auth = gitAuthArgs(url, tokenForGitUrl(url, ctx.config, repoTokens(ctx)));
  const rawBranch = ctx.branch || (await currentBranch(repoRoot)) || "HEAD";
  const branch = rawBranch.startsWith("-") ? "HEAD" : rawBranch;
  await git(repoRoot, [...auth, "push", "origin", `HEAD:${branch}`]);
  logger.info({ groupId: ctx.groupId, repo: ctx.repo, branch }, "group knowledge repo pushed");
  return true;
}

/**
 * Build a group knowledge-repo context, or null if the group has no repo. The
 * git token is resolved from `actingUserId` (the member/admin performing the
 * operation). Shared by the HTTP routes, the skill-load path, and the group
 * repo MCP tools so they all resolve the same repo/branch/token.
 */
export function groupKnowledgeRepoContextFor(
  store: Store,
  groupId: string,
  actingUserId: string,
  config: AppConfig,
  groupName?: string,
): GroupKnowledgeRepoContext | null {
  const { repo, branch, selected } = store.getGroupKnowledgeRepo(groupId);
  if (!repo) {
    return null;
  }
  // Use the acting user's git tokens (mirrors knowledgeRepoContextFor):
  // ensureGroupClone/groupCommitAndPush route them via tokenForGitUrl per git
  // call (internal host vs github.com), so a non-matching host (or local path)
  // simply clones tokenless. External token covers a github.com repo on GHES (git-05).
  const tokens = store.getGitTokens(actingUserId);
  return {
    groupId,
    groupName,
    repo,
    branch,
    selected,
    token: tokens.internal ?? null,
    externalToken: tokens.external ?? null,
    config,
  };
}

/**
 * Build a context for every group knowledge repo a user shares (their groups
 * that have a repo connected), with the token resolved from that user. Used to
 * load all of a member's group repos as plugin roots for their avatar chats.
 */
export function groupKnowledgeRepoContextsForUser(
  store: Store,
  userId: string,
  config: AppConfig,
): GroupKnowledgeRepoContext[] {
  const tokens = store.getGitTokens(userId);
  return store.listGroupKnowledgeReposForUser(userId).map((g) => ({
    groupId: g.groupId,
    groupName: g.groupName,
    repo: g.repo,
    branch: g.branch,
    selected: g.selected,
    token: tokens.internal ?? null,
    externalToken: tokens.external ?? null,
    config,
  }));
}
