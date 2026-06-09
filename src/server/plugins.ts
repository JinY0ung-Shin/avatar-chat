import fs from "node:fs/promises";
import path from "node:path";
import { marketplaceCloneUrl, pathExists, sanitizeName, syncGitRepo } from "./marketplace.js";
import type { AppConfig, Plugin, PluginRoot } from "./types.js";

// Clone-once-per-process cache keyed by the destination clone path. Avoids
// re-fetching the same repo on every chat turn; refresh is explicit (process
// restart or a future refresh endpoint clearing this set).
const clonedPaths = new Set<string>();

interface MarketplaceEntry {
  name?: string;
  source?: unknown;
}
interface MarketplaceManifest {
  plugins?: MarketplaceEntry[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function isPluginDir(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, ".claude-plugin", "plugin.json"));
}

/**
 * Resolve a cloned repo into one or more SDK plugin roots:
 * - a single-plugin repo (`.claude-plugin/plugin.json` at root) → [root]
 * - a marketplace repo (`.claude-plugin/marketplace.json`) → each listed
 *   plugin's directory (relative `./...` sources, the common case)
 */
export async function resolvePluginRoots(repoRoot: string, label: string, onWarn?: (m: string) => void): Promise<string[]> {
  if (await isPluginDir(repoRoot)) {
    return [repoRoot];
  }

  const manifest = await readJson<MarketplaceManifest>(path.join(repoRoot, ".claude-plugin", "marketplace.json"));
  if (manifest && Array.isArray(manifest.plugins)) {
    const roots: string[] = [];
    for (const entry of manifest.plugins) {
      const source = entry?.source;
      // Only relative in-repo sources are expanded; remote/object sources in a
      // marketplace would need their own clone and are skipped with a warning.
      if (typeof source === "string" && source.startsWith(".")) {
        const dir = path.resolve(repoRoot, source);
        if (await isPluginDir(dir)) {
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
): Promise<PluginRoot[]> {
  const roots: PluginRoot[] = [];
  for (const plugin of plugins) {
    const destination = path.join(
      config.dataDir,
      "plugins",
      sanitizeName(userId),
      sanitizeName(plugin.repo),
    );
    try {
      if (!clonedPaths.has(destination)) {
        const url = marketplaceCloneUrl(plugin.repo, config.githubToken);
        await syncGitRepo(url, destination, plugin.ref ?? undefined);
        clonedPaths.add(destination);
      }
    } catch (error) {
      // A refresh/clone failure is non-fatal if we already have a cached clone.
      if (!(await pathExists(destination))) {
        const detail = error instanceof Error ? error.message : String(error);
        onWarn?.(`${plugin.repo}: clone failed (${detail})`);
        continue;
      }
      onWarn?.(`${plugin.repo}: refresh failed, using cached clone`);
    }

    if (!(await pathExists(destination))) {
      onWarn?.(`${plugin.repo}: plugin path not found after clone`);
      continue;
    }
    for (const root of await resolvePluginRoots(destination, plugin.repo, onWarn)) {
      roots.push({ type: "local", path: root });
    }
  }
  return roots;
}
