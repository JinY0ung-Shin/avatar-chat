import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Sanitize an arbitrary repo/source string into a safe directory segment. */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Resolve a repo reference (`owner/repo`, a github URL, or a git/https URL) into
 * a clonable git URL, injecting a token for private repos when provided.
 */
export function marketplaceCloneUrl(source: string, token?: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    if (token) {
      return `https://x-access-token:${encodeURIComponent(token)}@github.com/${source}.git`;
    }
    return `https://github.com/${source}.git`;
  }
  if (token && source.startsWith("https://github.com/")) {
    return source.replace(
      "https://github.com/",
      `https://x-access-token:${encodeURIComponent(token)}@github.com/`,
    );
  }
  return source;
}

/** Clone (or fetch+checkout) a git repo into `destination`. */
export async function syncGitRepo(url: string, destination: string, ref?: string): Promise<void> {
  if (await pathExists(path.join(destination, ".git"))) {
    await execFileAsync("git", ["-C", destination, "fetch", "--all", "--prune"], {
      timeout: 120_000,
    });
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", url, destination], {
      timeout: 120_000,
    });
  }
  if (ref) {
    await execFileAsync("git", ["-C", destination, "checkout", ref], { timeout: 60_000 });
  }
}
