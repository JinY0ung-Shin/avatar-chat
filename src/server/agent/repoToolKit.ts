// Shared CRUD skeleton for the knowledge-repo MCP servers (`repoTools.ts` =
// the owner's personal repo, `groupRepoTools.ts` = a group's shared repo).
//
// Both servers expose the same five file-CRUD tools — list_files / read_file /
// write_file / scaffold_skill / commit — over a guard → resolve → ensureClone →
// op → decode pipeline. The ONLY differences are:
//   - the guard/resolve chain (personal = owner-only; group = owner-only +
//     resolve the named group + an admin role gate on write/scaffold/commit),
//   - which clone/commit helpers run (knowledgeRepo vs groupKnowledgeRepo),
//   - a handful of success-message strings + the commit audit action/detail,
//   - tool descriptions / arg-`describe` text (personal vs group wording).
//
// This module factors the loop body — the owner gate, the resolve→clone→op→decode
// try/catch, and the shared (byte-identical, English, agent-facing) error
// messages — into small parameterized runners. Each caller still owns its own
// `tool()` descriptions, argument schemas, success strings, and audit calls, so
// every string that units.test.ts asserts stays at the call site unchanged.

import { scrubGitError } from "../marketplace.js";
import { decodeRepoFsError, text } from "./mcpTools.js";

/** Shared owner-only refusal text (identical in both repo servers). */
export const OWNER_ONLY = "This tool can only be used by the avatar owner.";

/** Render a `listTree` result the same way both servers do (dirs get a trailing slash). */
export function formatTree(entries: Array<{ type: string; path: string }>): string {
  return entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n");
}

/**
 * The shared error message both servers return when a clone fails (load failure):
 * identical text including the no-Bash-fallback hint line. `units.test.ts` and the
 * CLAUDE.md "git remote work is MCP-only" rule depend on this wording.
 */
export function cloneFailureMessage(error: unknown): string {
  return `Failed to load the repository: ${scrubGitError(error)}\nCheck the repository address/branch and token permissions. Do not clone directly with Bash git — the shell has no git credentials.`;
}

/** The shared commit/push failure message (with the no-Bash-fallback hint). */
export function commitFailureMessage(error: unknown): string {
  return `Commit/push failed: ${scrubGitError(error)}\nCheck the write permission of the token (GIT_TOKEN) and the remote branch protection settings. Do not work around this with Bash \`git push\` — the shell has no git credentials.`;
}

/** read_file's shared error decode (identical sentinels/wording in both servers). */
export function readFileErrorMessage(error: unknown): string {
  return decodeRepoFsError(scrubGitError(error), {
    tooLarge: "The file is too large.",
    notAFile: "Not a file.",
    fallback: "Failed to read the file",
  });
}

/** write_file's shared error decode. */
export function writeFileErrorMessage(error: unknown): string {
  return decodeRepoFsError(scrubGitError(error), {
    tooLarge: "The content is too large.",
    fallback: "Failed to save the file",
  });
}

/** scaffold_skill's shared error decode. */
export function scaffoldErrorMessage(error: unknown): string {
  return decodeRepoFsError(scrubGitError(error), {
    skillExists: "A skill with the same name already exists.",
    fallback: "Failed to create the skill",
  });
}

/**
 * The repo-relative file ops both servers import from `knowledgeRepo` (the group
 * server reuses them on its own clone). Bundled so a runner can take one object.
 */
export interface RepoFileOps {
  listTree: (repoRoot: string) => Promise<Array<{ type: string; path: string }>>;
  readFile: (repoRoot: string, p: string) => Promise<string>;
  writeFile: (repoRoot: string, p: string, content: string) => Promise<void>;
  scaffoldSkill: (repoRoot: string, name: string, description: string) => Promise<string>;
}

/**
 * Outcome of a per-tool guard/resolve chain. `ok` carries the resolved repo
 * context (already past owner/role/no-repo checks) plus the working-tree clone
 * path; otherwise it carries an MCP error result returned to the model verbatim.
 */
export type Resolved<C> =
  | { ok: true; repo: C }
  | { ok: false; result: ReturnType<typeof text> };

/**
 * Run the shared list_files body: clone the resolved repo, list its tree, and
 * either report it empty or hand the rendered tree body to `onBody`. Clone
 * failures map to the shared `cloneFailureMessage`. `onBody`/`empty` carry the
 * caller-specific success wording (personal vs group), so no string moves here.
 */
export async function runListFiles<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  listTree: RepoFileOps["listTree"],
  opts: { empty: string; onBody: (body: string) => string },
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    const entries = await listTree(repoRoot);
    if (entries.length === 0) return text(opts.empty);
    return text(opts.onBody(formatTree(entries)));
  } catch (error) {
    return text(cloneFailureMessage(error), true);
  }
}

/** Run the shared read_file body (clone → read → decode). */
export async function runReadFile<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  readFile: RepoFileOps["readFile"],
  path: string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    return text(await readFile(repoRoot, path));
  } catch (error) {
    return text(readFileErrorMessage(error), true);
  }
}

/** Run the shared write_file body; `success` builds the caller-specific message. */
export async function runWriteFile<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  writeFile: RepoFileOps["writeFile"],
  args: { path: string; content: string },
  success: (path: string) => string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    await writeFile(repoRoot, args.path, args.content);
    return text(success(args.path));
  } catch (error) {
    return text(writeFileErrorMessage(error), true);
  }
}

/**
 * Run the shared scaffold_skill body. The success string is byte-identical in
 * both servers, so it lives here; only the description/arg text (kept by callers)
 * differs.
 */
export async function runScaffoldSkill<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  scaffoldSkill: RepoFileOps["scaffoldSkill"],
  args: { name: string; description?: string },
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    const filePath = await scaffoldSkill(repoRoot, args.name, args.description ?? "");
    return text(
      `Created a new skill: ${filePath} (fill in the content with write_file, then push with commit.)`,
    );
  } catch (error) {
    return text(scaffoldErrorMessage(error), true);
  }
}
