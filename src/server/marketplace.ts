import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const DEFAULT_GITHUB_HOST = "github.com";

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

/** Normalize an operator-provided GitHub host into the host[:port] part only. */
export function normalizeGithubHost(host?: string | null): string {
  const raw = (host ?? "").trim();
  if (!raw) {
    return DEFAULT_GITHUB_HOST;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).host || DEFAULT_GITHUB_HOST;
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/\/+$/g, "") || DEFAULT_GITHUB_HOST;
  }
}

/**
 * Redact the auth header from a git error before it's returned to a client or
 * logged. `execFile` rejections embed the full argv — including our
 * `http.extraHeader=Authorization: Basic <base64>` — in `err.message`, and that
 * base64 trivially decodes back to the token. Strip it so the token never
 * escapes via an error path.
 */
export function scrubGitError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/Authorization: Basic [^\s'"]+/g, "Authorization: Basic [REDACTED]");
}

/**
 * Reject a source that git would interpret as an option (leading `-`) rather
 * than a repo. Combined with a `--` separator before positionals, this blocks
 * argument-injection (e.g. `--upload-pack=…` → RCE).
 */
function assertSafeArg(value: string, what: string): void {
  if (value.startsWith("-")) {
    throw new Error(`Invalid ${what}: must not start with "-"`);
  }
}

/**
 * Resolve a repo reference (`owner/repo`, a github URL, or a git/https URL) into
 * a clonable git URL.
 *
 * The token is intentionally NOT injected here: embedding it in the remote URL
 * would persist it in the clone's `.git/config` on disk. Authentication is
 * instead supplied per-invocation via `gitAuthArgs` (an `http.extraHeader`),
 * which git uses for the transfer but never writes to disk.
 */
export function marketplaceCloneUrl(source: string, githubHost = DEFAULT_GITHUB_HOST): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return `https://${normalizeGithubHost(githubHost)}/${source}.git`;
  }
  return source;
}

/**
 * Per-invocation git auth for a token, as `git -c` args injecting an
 * `Authorization: Basic …` HTTP header (GitHub accepts `x-access-token:TOKEN`).
 * Returns [] when there's no token or the URL isn't an https transfer (e.g.
 * ssh/git@), so the header is only attached where it's actually used.
 *
 * Unlike a token-in-URL remote, the header lives only in this process's argv —
 * git never persists it to `.git/config`, so the clone on disk stays clean.
 */
export function gitAuthArgs(url: string, token?: string): string[] {
  // Case-insensitive https check to match `tokenForGitUrl` (gitCredentials.ts):
  // a `HTTPS://`-cased URL must route auth consistently in both places (git-08).
  if (!token || !/^https:\/\//i.test(url)) {
    return [];
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

/**
 * Resolve the revision a clone's working tree should be forced to:
 * an explicit `ref` (preferring its remote-tracking branch, else the ref as-is
 * for a tag/sha), or the default branch's upstream when no ref is given.
 */
async function resolveTarget(destination: string, ref?: string): Promise<string> {
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", destination, ...args], { timeout: 60_000 });
  if (ref) {
    try {
      await git("rev-parse", "--verify", "--quiet", `origin/${ref}`);
      return `origin/${ref}`;
    } catch {
      return ref;
    }
  }
  try {
    await git("rev-parse", "--verify", "--quiet", "@{upstream}");
    return "@{upstream}";
  } catch {
    return "HEAD";
  }
}

/**
 * Clone (or fetch) a git repo into `destination` and force its working tree to
 * exactly match the target revision. When `token` is given it is passed as a
 * per-invocation auth header (see `gitAuthArgs`), never written into the remote.
 *
 * `git fetch` alone only moves remote-tracking refs — it leaves the working
 * tree on the old commit, so files deleted upstream (e.g. a skill removed from
 * a marketplace) would linger on refresh. We `reset --hard` to the fetched
 * target and `clean -fd` untracked leftovers so the clone is an exact mirror.
 *
 * Shallow but multi-branch: a plain `clone --depth 1` implies `--single-branch`
 * (only the default branch's refspec), so a plugin pinned to a NON-default
 * branch never materializes `origin/<ref>` — `resolveTarget` falls back to the
 * raw ref and `reset --hard <branch>` errors on every clone and refresh. We add
 * `--no-single-branch` so all branches' remote-tracking refs exist (still
 * shallow), and the existing `fetch --all` keeps them current on refresh (git-03).
 */
export async function syncGitRepo(
  url: string,
  destination: string,
  ref?: string,
  token?: string,
): Promise<void> {
  assertSafeArg(url, "repo");
  // The ref reaches `git reset --hard <ref>` (via resolveTarget's fallback) and
  // a `git rev-parse origin/<ref>`; reject a leading-dash value git would parse
  // as an option, consistent with the url guard above (git-04).
  if (ref !== undefined) {
    assertSafeArg(ref, "ref");
  }
  const auth = gitAuthArgs(url, token);
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", destination, ...args], { timeout: 120_000 });

  if (await pathExists(path.join(destination, ".git"))) {
    await git(...auth, "fetch", "--all", "--prune", "--tags");
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // `--` stops git from treating a crafted url/destination as an option.
    // `--no-single-branch` keeps every branch's remote-tracking ref (so a
    // non-default `ref` resolves) while staying shallow.
    await execFileAsync(
      "git",
      [...auth, "clone", "--depth", "1", "--no-single-branch", "--", url, destination],
      { timeout: 120_000 },
    );
  }

  const target = await resolveTarget(destination, ref);
  await git("reset", "--hard", target);
  await git("clean", "-fd");
}
