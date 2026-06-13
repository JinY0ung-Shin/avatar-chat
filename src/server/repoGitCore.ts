// Shared low-level git plumbing for the repo clone/commit/push paths
// (knowledgeRepo.ts, groupKnowledgeRepo.ts, gitRepos.ts). These three modules
// each re-implemented the same `git -C <root> …` exec wrapper plus a
// `currentBranch` and a porcelain dirty-status reader — extracted here so they
// share one definition rather than copy-paste. Everything is keyed off a single
// `repoRoot`, matching the per-clone working-tree model the callers use.
//
// The leading-dash arg guards (`safeIdentity`/`safePushBranch`) live in
// repoGitGuards.ts; this module re-exports them so a caller can pull all the
// shared git primitives from one place. Behavior is byte-for-byte identical to
// the inlined versions it replaces.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export { safeIdentity, safePushBranch } from "./repoGitGuards.js";

/**
 * Run `git -C <repoRoot> <args>` and resolve with `{stdout, stderr}`. The
 * default timeout (120s) matches every call site's prior inline wrapper; pass an
 * explicit timeout to override (the clone paths use longer ones at their own
 * `execFile` call, outside this helper).
 */
export function git(repoRoot: string, args: string[], timeout = 120_000) {
  return execFileAsync("git", ["-C", repoRoot, ...args], { timeout });
}

/**
 * The clone's `origin` remote URL (clean, without any auth — auth is supplied
 * per-call via `http.extraHeader`, never written to `.git/config`), or null when
 * there's no origin / on error. Used to detect that the configured repo changed
 * out from under an existing clone so the stale one can be re-cloned.
 */
export async function originUrl(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["remote", "get-url", "origin"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The clone's current branch name, or null when detached (`HEAD`) or on error.
 * Identical to the inline `currentBranch` each repo module used.
 */
export async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const name = stdout.trim();
    return name && name !== "HEAD" ? name : null;
  } catch {
    return null;
  }
}

/**
 * Relative paths with uncommitted changes, parsed from `git status --porcelain`.
 *
 * CRITICAL: the porcelain flag is parameterized so each caller keeps its CURRENT
 * behavior — knowledge/group repos use plain `--porcelain`, the user-registered
 * git repos use `--porcelain -uall` (list untracked files individually). This is
 * a deferred breaking item; do NOT unify the flags here.
 */
export async function dirtyPaths(
  repoRoot: string,
  extraStatusArgs: string[] = [],
): Promise<string[]> {
  const { stdout } = await git(repoRoot, ["status", "--porcelain", ...extraStatusArgs]);
  return stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}
