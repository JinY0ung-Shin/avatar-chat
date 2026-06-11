import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import logger from "./logger.js";
import { gitAuthArgs, marketplaceCloneUrl, pathExists, sanitizeName } from "./marketplace.js";
import fsSync from "node:fs";
import type { AppConfig, KnowledgeRepoStatus, KnowledgeRepoTreeEntry } from "./types.js";
import type { Store } from "./store.js";

const execFileAsync = promisify(execFile);

// The user's knowledge-repo working tree is a FULL clone (unlike the read-only
// shallow plugin clones) so the avatar can commit and push edits back. It lives
// at ${dataDir}/knowledge/${userId}. All file access is constrained to this
// directory — see `resolveInRepo`, which rejects path traversal.

/** A directory not under version control, holding a hidden git dir per skill. */
const SKILL_DIR = "skills";
/** Files/dirs never listed or written through the repo tools. */
const IGNORED_SEGMENTS = new Set([".git"]);
/** Cap how much of a file the repo tools will read, to avoid loading huge blobs. */
const MAX_FILE_BYTES = 512 * 1024;

export interface KnowledgeRepoContext {
  userId: string;
  repo: string;
  branch: string | null;
  token: string | null;
  config: AppConfig;
  // Subset of plugin names to load when the repo is a marketplace of many;
  // null means "load all". Mirrors a plugin's `selected`.
  selected: string[] | null;
}

/** On-disk clone path for a user's knowledge-repo working tree. */
export function knowledgeClonePath(userId: string, config: AppConfig): string {
  return path.join(config.dataDir, "knowledge", sanitizeName(userId));
}

/**
 * Resolve a repo-relative path to an absolute one, rejecting any path that
 * escapes the repo root (`..`, absolute paths, symlink-style tricks). Returns
 * null when the path is unsafe. The repo root itself resolves to "".
 */
export function resolveInRepo(repoRoot: string, relPath: string): string | null {
  // Reject absolute paths outright rather than silently reinterpreting them as
  // repo-relative (which would make "/etc/passwd" look "safe").
  if (path.isAbsolute(relPath)) {
    return null;
  }
  const normalized = path.normalize(relPath).replace(/^(\.\/)+/, "");
  if (normalized === "" || normalized === ".") {
    return repoRoot;
  }
  const segments = normalized.split(/[\\/]/);
  if (segments.some((s) => s === ".." || IGNORED_SEGMENTS.has(s))) {
    return null;
  }
  const abs = path.resolve(repoRoot, normalized);
  const root = path.resolve(repoRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return null;
  }
  return abs;
}

/**
 * Verify that an already lexically-resolved path stays inside the repo even
 * after following symlinks. The clone is a full checkout of a user-controlled
 * repo, and git preserves committed symlinks — so `evil -> /etc/passwd` would
 * pass the purely-lexical `resolveInRepo` check. We realpath the deepest
 * existing ancestor (the target itself for reads; its parent for not-yet-created
 * writes) and confirm it's still under the repo root's realpath. Returns null
 * if it escapes. `mustExist` distinguishes read (target must exist) from write
 * (parent must exist, leaf may not).
 */
function realpathContained(repoRoot: string, abs: string, mustExist: boolean): string | null {
  let realRoot: string;
  try {
    realRoot = fsSync.realpathSync(repoRoot);
  } catch {
    return null;
  }
  const within = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);

  // Fast path: the target itself exists — realpath it directly.
  try {
    return within(fsSync.realpathSync(abs)) ? abs : null;
  } catch {
    if (mustExist) {
      return null; // read of a non-existent target
    }
  }

  // Write to a not-yet-existing path: realpath the DEEPEST EXISTING ancestor so
  // a symlinked ancestor (at any depth) can't let a later mkdir/write escape.
  // The non-existing tail is appended lexically and re-validated against root.
  let ancestor = path.dirname(abs);
  while (ancestor !== path.dirname(ancestor)) {
    try {
      const realAncestor = fsSync.realpathSync(ancestor);
      if (!within(realAncestor)) {
        return null;
      }
      // Recompose: real ancestor + the lexical remainder below it.
      const rel = path.relative(ancestor, abs);
      const recomposed = path.resolve(realAncestor, rel);
      return within(recomposed) ? recomposed : null;
    } catch {
      ancestor = path.dirname(ancestor); // climb until an existing dir is found
    }
  }
  return null;
}

function git(repoRoot: string, args: string[], timeout = 120_000) {
  return execFileAsync("git", ["-C", repoRoot, ...args], { timeout });
}

/** Configure local commit identity on the clone (no global git config touched). */
async function setIdentity(repoRoot: string, name: string, email: string): Promise<void> {
  await git(repoRoot, ["config", "user.name", name]);
  await git(repoRoot, ["config", "user.email", email]);
}

/**
 * Ensure the user's knowledge repo is cloned (full clone) and up to date on
 * the configured branch. Returns the working-tree path. Fetches + hard-resets
 * to the remote branch tip if already cloned.
 */
export async function ensureClone(ctx: KnowledgeRepoContext): Promise<string> {
  const repoRoot = knowledgeClonePath(ctx.userId, ctx.config);
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  // Reject values git would read as options (e.g. `--upload-pack=…` → RCE).
  if (url.startsWith("-") || (ctx.branch && ctx.branch.startsWith("-"))) {
    throw new Error("Invalid repo or branch");
  }
  const auth = gitAuthArgs(url, ctx.token ?? undefined);

  if (await pathExists(path.join(repoRoot, ".git"))) {
    await git(repoRoot, [...auth, "fetch", "--prune", "origin"]);
  } else {
    await fs.mkdir(path.dirname(repoRoot), { recursive: true });
    // `--` stops a crafted url/repoRoot from being parsed as an option.
    const args = [...auth, "clone"];
    if (ctx.branch) {
      args.push("--branch", ctx.branch);
    }
    args.push("--", url, repoRoot);
    await execFileAsync("git", args, { timeout: 180_000 });
    logger.info({ userId: ctx.userId, repo: ctx.repo }, "knowledge repo cloned");
  }

  // Align the working tree with the chosen branch's remote tip.
  const branch = ctx.branch || (await currentBranch(repoRoot));
  if (branch && !branch.startsWith("-")) {
    try {
      await git(repoRoot, ["checkout", "-B", branch, `origin/${branch}`]);
    } catch {
      // Branch may not exist on the remote yet (fresh repo) — stay on whatever
      // HEAD the clone produced.
    }
  }
  return repoRoot;
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

/**
 * List the repo's tracked files + directories (excluding `.git`), as relative
 * POSIX paths, sorted dirs-then-files for a stable tree render.
 */
export async function listTree(repoRoot: string): Promise<KnowledgeRepoTreeEntry[]> {
  const entries: KnowledgeRepoTreeEntry[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (IGNORED_SEGMENTS.has(dirent.name)) {
        continue;
      }
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        entries.push({ path: rel, type: "dir" });
        await walk(path.join(dir, dirent.name), rel);
      } else if (dirent.isFile()) {
        entries.push({ path: rel, type: "file" });
      }
    }
  }
  await walk(repoRoot, "");
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return entries;
}

/** Read a file's text content. Throws on traversal, missing file, or oversize. */
export async function readFile(repoRoot: string, relPath: string): Promise<string> {
  const lexical = resolveInRepo(repoRoot, relPath);
  if (!lexical || lexical === repoRoot) {
    throw new Error("INVALID_PATH");
  }
  // Follow symlinks and re-check containment (defeats committed `evil -> /etc/...`).
  const abs = realpathContained(repoRoot, lexical, true);
  if (!abs) {
    throw new Error("INVALID_PATH");
  }
  const stat = await fs.lstat(abs);
  if (stat.isSymbolicLink()) {
    throw new Error("INVALID_PATH");
  }
  if (!stat.isFile()) {
    throw new Error("NOT_A_FILE");
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  return fs.readFile(abs, "utf8");
}

/** Write (creating parent dirs) a text file. Throws on traversal/oversize. */
export async function writeFile(repoRoot: string, relPath: string, content: string): Promise<void> {
  const lexical = resolveInRepo(repoRoot, relPath);
  if (!lexical || lexical === repoRoot) {
    throw new Error("INVALID_PATH");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  // Resolve symlinks on the deepest existing ancestor BEFORE creating any dirs:
  // a committed symlink ancestor (e.g. `skills -> /tmp`) must not let mkdir/write
  // escape the repo. `abs` is the realpath-validated, repo-contained target.
  const abs = realpathContained(repoRoot, lexical, false);
  if (!abs) {
    throw new Error("INVALID_PATH");
  }
  // Refuse to write through an existing symlink at the leaf.
  try {
    if ((await fs.lstat(abs)).isSymbolicLink()) {
      throw new Error("INVALID_PATH");
    }
  } catch (e) {
    if (e instanceof Error && e.message === "INVALID_PATH") throw e;
    // ENOENT: leaf doesn't exist yet — fine.
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** Delete a tracked file. Throws on traversal. No-op if already gone. */
export async function deleteFile(repoRoot: string, relPath: string): Promise<void> {
  const lexical = resolveInRepo(repoRoot, relPath);
  if (!lexical || lexical === repoRoot) {
    throw new Error("INVALID_PATH");
  }
  // Containment of the parent (realpath'd) guards against symlinked ancestors;
  // `fs.rm` won't follow a symlinked leaf (it removes the link itself).
  const abs = realpathContained(repoRoot, lexical, false);
  if (!abs) {
    throw new Error("INVALID_PATH");
  }
  await fs.rm(abs, { force: true });
}

/**
 * Scaffold a new skill under `skills/<name>/SKILL.md` with a minimal frontmatter
 * stub, and ensure the repo advertises it as a marketplace (creating/updating
 * `.claude-plugin/marketplace.json`). Returns the SKILL.md relative path so the
 * UI can open it for editing. Throws if the skill dir already exists.
 */
export async function scaffoldSkill(
  repoRoot: string,
  name: string,
  description: string,
): Promise<string> {
  const slug = sanitizeName(name).toLowerCase().replace(/^-+|-+$/g, "") || "skill";
  const skillRel = `${SKILL_DIR}/${slug}`;
  const abs = resolveInRepo(repoRoot, skillRel);
  if (!abs) {
    throw new Error("INVALID_PATH");
  }
  if (await pathExists(abs)) {
    throw new Error("SKILL_EXISTS");
  }
  const desc = description.trim() || `${slug} skill`;
  const skillMd = `---
name: ${slug}
description: ${desc}
---

# ${name}

Describe what this skill does and when the avatar should use it.
`;
  await writeFile(repoRoot, `${skillRel}/SKILL.md`, skillMd);
  // The plugin manifest the SDK looks for inside each marketplace plugin dir.
  await writeFile(
    repoRoot,
    `${skillRel}/.claude-plugin/plugin.json`,
    `${JSON.stringify({ name: slug, description: desc }, null, 2)}\n`,
  );
  await ensureMarketplaceManifest(repoRoot, slug);
  return `${skillRel}/SKILL.md`;
}

/**
 * Ensure `.claude-plugin/marketplace.json` exists and lists the given plugin
 * (by relative source). Idempotent: an already-listed plugin is left untouched.
 */
async function ensureMarketplaceManifest(repoRoot: string, slug: string): Promise<void> {
  const manifestRel = ".claude-plugin/marketplace.json";
  const abs = resolveInRepo(repoRoot, manifestRel)!;
  interface Entry {
    name?: string;
    source?: string;
  }
  interface Manifest {
    name?: string;
    plugins?: Entry[];
  }
  let manifest: Manifest = { name: "marketplace", plugins: [] };
  if (await pathExists(abs)) {
    try {
      manifest = JSON.parse(await fs.readFile(abs, "utf8")) as Manifest;
    } catch {
      // Corrupt manifest: start fresh rather than fail the scaffold.
      manifest = { name: "marketplace", plugins: [] };
    }
  }
  if (!Array.isArray(manifest.plugins)) {
    manifest.plugins = [];
  }
  const source = `./${SKILL_DIR}/${slug}`;
  if (!manifest.plugins.some((p) => p?.source === source)) {
    manifest.plugins.push({ name: slug, source });
  }
  await writeFile(repoRoot, manifestRel, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Relative paths with uncommitted changes (porcelain), excluding nothing. */
export async function dirtyPaths(repoRoot: string): Promise<string[]> {
  const { stdout } = await git(repoRoot, ["status", "--porcelain"]);
  return stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/** Working-tree status (cloned?, branch, dirty paths). */
export async function status(ctx: KnowledgeRepoContext): Promise<KnowledgeRepoStatus> {
  const repoRoot = knowledgeClonePath(ctx.userId, ctx.config);
  const cloned = await pathExists(path.join(repoRoot, ".git"));
  return {
    repo: ctx.repo,
    branch: ctx.branch || (cloned ? await currentBranch(repoRoot) : null),
    cloned,
    dirty: cloned ? await dirtyPaths(repoRoot) : [],
  };
}

/**
 * Restore every tracked `.mcp.json` to its committed (HEAD) state, discarding
 * the runtime `stripManagedMcpServers` edit so it never gets committed/pushed.
 * Best-effort and tolerant: untracked `.mcp.json` files (genuinely new, added
 * by the avatar) are left alone; if `ls-files` finds none it's a no-op.
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
  // `--` so paths are never parsed as options. Ignore failures (e.g. a path
  // that's tracked but unchanged) — this is purely defensive cleanup.
  try {
    await git(repoRoot, ["checkout", "HEAD", "--", ...tracked]);
  } catch {
    /* best-effort */
  }
}

/**
 * Stage all changes, commit with the user's identity, and push to the remote
 * branch. Returns false (no commit) when the tree is clean. Throws on git
 * failure (auth, conflicts) so the route can surface the detail.
 */
export async function commitAndPush(
  ctx: KnowledgeRepoContext,
  message: string,
  identity: { name: string; email: string },
): Promise<boolean> {
  const repoRoot = knowledgeClonePath(ctx.userId, ctx.config);
  if (!(await pathExists(path.join(repoRoot, ".git")))) {
    throw new Error("NOT_CLONED");
  }
  // Guard against identity values git would read as options (passed positionally
  // after the config key). Fall back to a safe default rather than failing.
  const name = identity.name.startsWith("-") ? "noah-almighty" : identity.name;
  const email = identity.email.startsWith("-") ? "avatar@noah-almighty.local" : identity.email;
  await setIdentity(repoRoot, name, email);
  // Undo any in-place `.mcp.json` strip we did at load time (removing the
  // app-managed `hex-ssh` server so it can't shadow our keyed registration —
  // see plugins.ts `stripManagedMcpServers`). That edit is a runtime-only
  // concern; restoring each tracked `.mcp.json` to HEAD keeps it out of the
  // user's repo. The avatar edits skills/docs via write_file, never `.mcp.json`,
  // so nothing legitimate is lost. Best-effort: ignore if there are none.
  await restoreTrackedMcpJson(repoRoot);
  await git(repoRoot, ["add", "-A"]);
  if ((await dirtyPaths(repoRoot)).length === 0) {
    return false;
  }
  // commitMsg is the value of `-m` (a discrete argv element), so it's never
  // parsed as a flag even if it starts with `-`.
  const commitMsg = message.trim() || "Update knowledge repo";
  await git(repoRoot, ["commit", "-m", commitMsg]);

  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  const auth = gitAuthArgs(url, ctx.token ?? undefined);
  const rawBranch = ctx.branch || (await currentBranch(repoRoot)) || "HEAD";
  const branch = rawBranch.startsWith("-") ? "HEAD" : rawBranch;
  await git(repoRoot, [...auth, "push", "origin", `HEAD:${branch}`]);
  logger.info({ userId: ctx.userId, repo: ctx.repo, branch }, "knowledge repo pushed");
  return true;
}

/**
 * Build a knowledge-repo context for a user, or null if no repo is configured.
 * Shared by the HTTP routes, the chat plugin-load path, and the agent's repo
 * tools so they all resolve the same repo/branch/token from the store.
 */
export function knowledgeRepoContextFor(
  store: Store,
  userId: string,
  config: AppConfig,
): KnowledgeRepoContext | null {
  const { repo, branch, selected } = store.getKnowledgeRepo(userId);
  if (!repo) {
    return null;
  }
  return { userId, repo, branch, selected, token: store.getGitToken(userId), config };
}

/**
 * Resolve the commit author identity for a user's knowledge-repo commits,
 * falling back to the display name / username when the explicit identity is
 * unset. A no-reply-style default email keeps commits valid without leaking a
 * real address.
 */
export function commitIdentityFor(
  store: Store,
  user: { id: string; username: string; displayName: string },
): { name: string; email: string } {
  const u = store.getUserById(user.id);
  return {
    name: u?.gitIdentityName || user.displayName || user.username,
    email: u?.gitIdentityEmail || `${user.username}@noah-almighty.local`,
  };
}
