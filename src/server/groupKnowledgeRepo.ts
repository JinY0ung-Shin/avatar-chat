import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import logger from "./logger.js";
import { gitAuthArgs, marketplaceCloneUrl, pathExists, sanitizeName } from "./marketplace.js";
import { tokenForGitUrl } from "./gitCredentials.js";
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
  token: string | null;
  config: AppConfig;
  /** Subset of plugin names to load when the repo is a marketplace; null = all. */
  selected: string[] | null;
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
 * knowledgeRepo.ts but keyed by groupId.
 */
export async function ensureGroupClone(ctx: GroupKnowledgeRepoContext): Promise<string> {
  const repoRoot = groupKnowledgeClonePath(ctx.groupId, ctx.config);
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  // Reject values git would read as options (e.g. `--upload-pack=…` → RCE).
  if (url.startsWith("-") || (ctx.branch && ctx.branch.startsWith("-"))) {
    throw new Error("Invalid repo or branch");
  }
  const auth = gitAuthArgs(url, tokenForGitUrl(url, ctx.config, { internal: ctx.token }));

  if (await pathExists(path.join(repoRoot, ".git"))) {
    await git(repoRoot, [...auth, "fetch", "--prune", "origin"]);
  } else {
    await fs.mkdir(path.dirname(repoRoot), { recursive: true });
    const args = [...auth, "clone"];
    if (ctx.branch) {
      args.push("--branch", ctx.branch);
    }
    args.push("--", url, repoRoot);
    await execFileAsync("git", args, { timeout: 180_000 });
    logger.info({ groupId: ctx.groupId, repo: ctx.repo }, "group knowledge repo cloned");
  }

  const branch = ctx.branch || (await currentBranch(repoRoot));
  if (branch && !branch.startsWith("-")) {
    try {
      await git(repoRoot, ["checkout", "-B", branch, `origin/${branch}`]);
    } catch {
      // Branch may not exist on the remote yet (fresh repo) — stay on HEAD.
    }
  }
  return repoRoot;
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
  const auth = gitAuthArgs(url, tokenForGitUrl(url, ctx.config, { internal: ctx.token }));
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
  // Use the acting user's internal git token (mirrors knowledgeRepoContextFor);
  // ensureGroupClone/groupCommitAndPush apply it via tokenForGitUrl per git call,
  // so a non-matching host (or local path) simply clones tokenless.
  return { groupId, groupName, repo, branch, selected, token: store.getGitToken(actingUserId), config };
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
  const token = store.getGitToken(userId);
  return store.listGroupKnowledgeReposForUser(userId).map((g) => ({
    groupId: g.groupId,
    groupName: g.groupName,
    repo: g.repo,
    branch: g.branch,
    selected: g.selected,
    token,
    config,
  }));
}
