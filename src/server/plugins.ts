import path from "node:path";
import { marketplaceCloneUrl, pathExists, sanitizeName, syncGitRepo } from "./marketplace.js";
import type { AppConfig, Plugin, PluginRoot } from "./types.js";

// Clone-once-per-process cache keyed by the destination clone path. Avoids
// re-fetching the same repo on every chat turn; refresh is explicit (process
// restart or a future refresh endpoint clearing this set).
const clonedPaths = new Set<string>();

/**
 * Clone each enabled plugin for an avatar into
 * `${dataDir}/plugins/${userId}/${sanitize(repo)}` and return local plugin
 * roots for the SDK. Clone failures are tolerated: the plugin is skipped and a
 * warning is emitted, never crashing the chat.
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
      if (await pathExists(destination)) {
        roots.push({ type: "local", path: destination });
      } else {
        onWarn?.(`${plugin.repo}: plugin path not found after clone`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onWarn?.(`${plugin.repo}: clone failed (${detail})`);
    }
  }
  return roots;
}
