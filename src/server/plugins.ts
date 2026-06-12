import fs from "node:fs/promises";
import path from "node:path";
import { marketplaceCloneUrl, pathExists, sanitizeName, scrubGitError, syncGitRepo } from "./marketplace.js";
import { tokenForGitUrl, type GitTokenSet } from "./gitCredentials.js";
import { ensureClone, type KnowledgeRepoContext } from "./knowledgeRepo.js";
import logger from "./logger.js";
import type {
  AppConfig,
  Plugin,
  PluginRoot,
  RepoPluginContents,
  RepoPluginEntry,
  SkillInfo,
} from "./types.js";

// Clone-once-per-process cache keyed by the destination clone path. Avoids
// re-fetching the same repo on every chat turn; refresh is explicit (process
// restart or the refresh endpoint, which clears the entry via `forgetClone`).
const clonedPaths = new Set<string>();

interface MarketplaceEntry {
  name?: string;
  source?: unknown;
}
interface MarketplaceManifest {
  plugins?: MarketplaceEntry[];
}

/** The on-disk clone path for a given user's plugin repo. */
export function pluginClonePath(userId: string, repo: string, config: AppConfig): string {
  return path.join(config.dataDir, "plugins", sanitizeName(userId), sanitizeName(repo));
}

/** Drop a destination from the clone-once cache so the next sync re-fetches. */
export function forgetClone(destination: string): void {
  clonedPaths.delete(destination);
}

/** The plugin name a repo subdirectory advertises (its `plugin.json` `name`). */
async function pluginNameAt(dir: string): Promise<string | null> {
  const manifest = await readJson<{ name?: string }>(
    path.join(dir, ".claude-plugin", "plugin.json"),
  );
  return typeof manifest?.name === "string" ? manifest.name : null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * MCP servers the APP registers itself (in claudeAgent), per-user-configured —
 * e.g. `hex-ssh`, which we inject with the owner's SSH key. A plugin's bundled
 * `.mcp.json` may declare a server of the SAME name but WITHOUT the per-user
 * env (the public ops plugin ships a keyless `hex-ssh`). Since MCP config is
 * keyed by server name, the two collide and only one survives — and the
 * plugin's keyless copy can shadow ours, so the avatar gets a server with no
 * key. We strip these names from each plugin `.mcp.json` before handing the
 * root to the SDK, leaving the app's keyed registration as the sole definition.
 */
export const APP_MANAGED_MCP_SERVERS = ["hex-ssh"] as const;

/**
 * Remove app-managed server names (above) from a plugin dir's `.mcp.json`,
 * rewriting it in place. Idempotent and tolerant: no file / not our server /
 * unparseable → no-op. Returns true if it rewrote the file.
 *
 * NOTE: for the knowledge repo this edits the avatar's COMMITTABLE working tree,
 * so `commitAndPush` restores `.mcp.json` from HEAD before `git add -A` — the
 * strip must never be pushed back to the user's repo. See knowledgeRepo.ts.
 */
export async function stripManagedMcpServers(rootDir: string): Promise<boolean> {
  const file = path.join(rootDir, ".mcp.json");
  const config = await readJson<Record<string, unknown>>(file);
  if (!config || typeof config !== "object") {
    return false;
  }
  let changed = false;
  for (const name of APP_MANAGED_MCP_SERVERS) {
    if (name in config) {
      delete config[name];
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  return changed;
}

async function isPluginDir(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, ".claude-plugin", "plugin.json"));
}

/**
 * Pull `name` and `description` out of a SKILL.md YAML frontmatter block. We
 * only need two scalar string keys, so a tiny line scanner beats pulling in a
 * full YAML parser (the project has no YAML dep). Returns null if the file has
 * no leading `---` frontmatter. Values may be quoted; quotes are stripped.
 */
function parseSkillFrontmatter(text: string): { name?: string; description?: string } | null {
  // Frontmatter must be the very first thing in the file.
  if (!/^---\r?\n/.test(text)) {
    return null;
  }
  // The closing fence must be a line that is exactly `---` (optional trailing
  // whitespace / CR), so a body line like `---foo` or `----` can't end it early.
  const closing = /\n---[ \t]*\r?(?:\n|$)/.exec(text);
  if (!closing) {
    return null;
  }
  const block = text.slice(text.indexOf("\n") + 1, closing.index);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1] as "name" | "description"] = value;
  }
  return out;
}

/** Read one skill's `SKILL.md` frontmatter into a SkillInfo, or null if absent/invalid. */
async function readSkill(skillDir: string, source: string): Promise<SkillInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const fm = parseSkillFrontmatter(raw);
  const name = fm?.name?.trim() || path.basename(skillDir);
  const description = fm?.description?.trim() ?? "";
  return { name, description, source };
}

/**
 * Enumerate the skills bundled in the given plugin roots by reading each root's
 * `skills/<name>/SKILL.md`. Each root carries a `source` label (e.g. "default"
 * or the plugin repo slug) so the UI can attribute skills to their origin.
 * Tolerant: a missing `skills/` dir or unreadable SKILL.md is simply skipped.
 * Skills are de-duplicated by name (first occurrence wins).
 */
export async function listSkillsInRoots(
  roots: { path: string; source: string }[],
): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>();
  for (const root of roots) {
    const skillsDir = path.join(root.path, "skills");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skill = await readSkill(path.join(skillsDir, entry.name), root.source);
      if (skill && !byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a cloned repo into one or more SDK plugin roots:
 * - a single-plugin repo (`.claude-plugin/plugin.json` at root) → [root]
 * - a marketplace repo (`.claude-plugin/marketplace.json`) → each listed
 *   plugin's directory (relative `./...` sources, the common case)
 *
 * `selected` (when non-null) restricts a marketplace repo to plugins whose
 * manifest `name` is in the set; `null` loads all. It has no effect on a
 * single-plugin repo.
 */
export async function resolvePluginRoots(
  repoRoot: string,
  label: string,
  onWarn?: (m: string) => void,
  selected?: string[] | null,
): Promise<string[]> {
  if (await isPluginDir(repoRoot)) {
    await stripManagedMcpServers(repoRoot);
    return [repoRoot];
  }

  const manifest = await readJson<MarketplaceManifest>(path.join(repoRoot, ".claude-plugin", "marketplace.json"));
  if (manifest && Array.isArray(manifest.plugins)) {
    const selectedSet = selected ? new Set(selected) : null;
    const roots: string[] = [];
    for (const entry of manifest.plugins) {
      const source = entry?.source;
      // Only relative in-repo sources are expanded; remote/object sources in a
      // marketplace would need their own clone and are skipped with a warning.
      if (typeof source === "string" && source.startsWith(".")) {
        const dir = path.resolve(repoRoot, source);
        if (await isPluginDir(dir)) {
          // Filter against the owner's selection by the manifest `name`,
          // falling back to the entry name when plugin.json omits one.
          if (selectedSet) {
            const name = (await pluginNameAt(dir)) ?? entry?.name;
            if (!name || !selectedSet.has(name)) {
              continue;
            }
          }
          // Strip any app-managed MCP server (e.g. a keyless `hex-ssh`) so it
          // can't shadow the app's keyed registration. See claudeAgent.
          await stripManagedMcpServers(dir);
          roots.push(dir);
          continue;
        }
        onWarn?.(`${label}: marketplace plugin "${entry?.name ?? source}" has no .claude-plugin/plugin.json`);
      } else {
        onWarn?.(`${label}: marketplace plugin "${entry?.name ?? "?"}" uses an unsupported source`);
      }
    }
    if (roots.length === 0) {
      onWarn?.(`${label}: marketplace contained no loadable plugins`);
    }
    return roots;
  }

  onWarn?.(`${label}: not a Claude plugin (no .claude-plugin/plugin.json or marketplace.json)`);
  return [];
}

/**
 * Inspect a cloned repo and list the plugins it contains, for the selection UI.
 * Mirrors `resolvePluginRoots`' layout detection but reports names instead of
 * resolving SDK roots.
 */
export async function inspectRepoContents(repoRoot: string): Promise<RepoPluginContents> {
  if (await isPluginDir(repoRoot)) {
    const name = (await pluginNameAt(repoRoot)) ?? "(unnamed)";
    return { kind: "single", plugins: [{ name, loadable: true }] };
  }

  const manifest = await readJson<MarketplaceManifest>(
    path.join(repoRoot, ".claude-plugin", "marketplace.json"),
  );
  if (manifest && Array.isArray(manifest.plugins)) {
    const plugins: RepoPluginEntry[] = [];
    for (const entry of manifest.plugins) {
      const source = entry?.source;
      if (typeof source === "string" && source.startsWith(".")) {
        const dir = path.resolve(repoRoot, source);
        const loadable = await isPluginDir(dir);
        const name = (loadable ? await pluginNameAt(dir) : null) ?? entry?.name ?? source;
        plugins.push({ name, loadable });
      } else if (entry?.name) {
        // Unsupported (remote/object) source — surfaced as non-loadable.
        plugins.push({ name: entry.name, loadable: false });
      }
    }
    return { kind: "marketplace", plugins };
  }

  return { kind: "none", plugins: [] };
}

/**
 * Resolve the repo-bundled default plugin (`config.defaultPluginsDir`) into
 * plugin roots loaded for EVERY avatar. No clone — it ships with the server.
 * A missing/invalid dir is tolerated with a warning (chat still works).
 */
export async function loadDefaultPluginRoots(
  config: AppConfig,
  onWarn?: (message: string) => void,
): Promise<PluginRoot[]> {
  const dir = config.defaultPluginsDir;
  if (!dir || !(await pathExists(dir))) {
    return [];
  }
  const roots: PluginRoot[] = [];
  for (const root of await resolvePluginRoots(dir, "default-skills", onWarn)) {
    roots.push({ type: "local", path: root });
  }
  return roots;
}

/** Display label attributed to skills coming from the avatar's knowledge repo. */
export const KNOWLEDGE_REPO_SOURCE = "지식 저장소";

/**
 * Resolve the avatar's personal knowledge repo into plugin roots, so the skills
 * and knowledge the avatar accumulates there are loaded for EVERY chat. The
 * repo is a FULL clone (via `ensureClone`) shared with the agent's repo-
 * management tools — we reuse that same working tree as a plugin root rather
 * than cloning twice.
 *
 * Failure-tolerant like `loadAvatarPluginRoots`: an unset repo returns `[]`
 * silently; a clone/fetch failure warns and returns `[]` so chat never breaks.
 */
export async function loadKnowledgeRepoRoots(
  ctx: KnowledgeRepoContext | null,
  onWarn?: (message: string) => void,
): Promise<PluginRoot[]> {
  if (!ctx) {
    return [];
  }
  try {
    const repoRoot = await ensureClone(ctx);
    const roots: PluginRoot[] = [];
    for (const root of await resolvePluginRoots(repoRoot, KNOWLEDGE_REPO_SOURCE, onWarn, ctx.selected)) {
      roots.push({ type: "local", path: root });
    }
    return roots;
  } catch (error) {
    onWarn?.(`${KNOWLEDGE_REPO_SOURCE}: 불러오기 실패 (${scrubGitError(error)})`);
    return [];
  }
}

/**
 * Like `loadKnowledgeRepoRoots` but returns `{path, source}` entries for the
 * skills/intro paths, which attribute each skill to its origin. Tolerant: any
 * failure contributes no skills.
 */
export async function knowledgeRepoSkillSources(
  ctx: KnowledgeRepoContext | null,
): Promise<{ path: string; source: string }[]> {
  if (!ctx) {
    return [];
  }
  try {
    const repoRoot = await ensureClone(ctx);
    const sources: { path: string; source: string }[] = [];
    for (const root of await resolvePluginRoots(repoRoot, KNOWLEDGE_REPO_SOURCE, undefined, ctx.selected)) {
      sources.push({ path: root, source: KNOWLEDGE_REPO_SOURCE });
    }
    return sources;
  } catch {
    return [];
  }
}

/**
 * Clone each enabled plugin for an avatar into
 * `${dataDir}/plugins/${userId}/${sanitize(repo)}` and return local plugin
 * roots for the SDK. A repo may be a single plugin or a marketplace of many.
 * Clone/resolve failures are tolerated: the plugin is skipped with a warning,
 * never crashing the chat.
 */
export async function loadAvatarPluginRoots(
  userId: string,
  plugins: Plugin[],
  config: AppConfig,
  onWarn?: (message: string) => void,
  // The avatar owner's internal/external git tokens, selected per repo host.
  userTokens?: string | null | GitTokenSet,
): Promise<PluginRoot[]> {
  const roots: PluginRoot[] = [];
  for (const plugin of plugins) {
    const destination = pluginClonePath(userId, plugin.repo, config);
    try {
      if (!clonedPaths.has(destination)) {
        const url = marketplaceCloneUrl(plugin.repo, config.githubHost);
        const token = tokenForGitUrl(url, config, userTokens);
        await syncGitRepo(url, destination, plugin.ref ?? undefined, token);
        clonedPaths.add(destination);
        logger.debug({ repo: plugin.repo, destination }, "plugin repo cloned");
      }
    } catch (error) {
      // A refresh/clone failure is non-fatal if we already have a cached clone.
      // Scrub the error: the git auth header (token) is embedded in its argv.
      const detail = scrubGitError(error);
      if (!(await pathExists(destination))) {
        onWarn?.(`${plugin.repo}: clone failed (${detail})`);
        logger.warn({ repo: plugin.repo, detail }, "plugin clone failed");
        continue;
      }
      onWarn?.(`${plugin.repo}: refresh failed, using cached clone`);
      logger.warn({ repo: plugin.repo, detail }, "plugin refresh failed, using cache");
    }

    if (!(await pathExists(destination))) {
      onWarn?.(`${plugin.repo}: plugin path not found after clone`);
      continue;
    }
    for (const root of await resolvePluginRoots(destination, plugin.repo, onWarn, plugin.selected)) {
      roots.push({ type: "local", path: root });
    }
  }
  return roots;
}

/**
 * Ensure a single plugin repo is cloned/up-to-date on disk and return its path.
 * `force` re-fetches even if the process already synced it this run (used by the
 * refresh endpoint); otherwise it respects the clone-once cache.
 */
export async function syncPluginRepo(
  userId: string,
  plugin: Pick<Plugin, "repo" | "ref">,
  config: AppConfig,
  force = false,
  userTokens?: string | null | GitTokenSet,
): Promise<string> {
  const destination = pluginClonePath(userId, plugin.repo, config);
  if (force) {
    forgetClone(destination);
  }
  if (!clonedPaths.has(destination)) {
    const url = marketplaceCloneUrl(plugin.repo, config.githubHost);
    const token = tokenForGitUrl(url, config, userTokens);
    await syncGitRepo(url, destination, plugin.ref ?? undefined, token);
    clonedPaths.add(destination);
  }
  return destination;
}
