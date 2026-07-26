import { DEFAULT_GITHUB_HOST, normalizeGithubHost } from "./marketplace.js";
import type { AppConfig } from "./types.js";

export const INTERNAL_GIT_TOKEN_SECRET_NAME = "GIT_TOKEN";
export const EXTERNAL_GIT_TOKEN_SECRET_NAME = "GITHUB_TOKEN";

export interface GitTokenSet {
  internal?: string | null;
  external?: string | null;
}

export function normalizeGitTokenInput(input?: string | null | GitTokenSet): GitTokenSet {
  if (!input || typeof input === "string") {
    return { internal: input || null, external: null };
  }
  return {
    internal: input.internal || null,
    external: input.external || null,
  };
}

export function gitHostFromSource(source: string): string | null {
  const raw = source.trim();
  if (!raw) {
    return null;
  }
  const scpLike = /^[^@\s]+@([^:\s]+):/.exec(raw);
  if (scpLike?.[1]) {
    return normalizeGithubHost(scpLike[1]);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      return normalizeGithubHost(new URL(raw).host);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Is this repo source hosted on the configured internal GitHub host?
 *
 * Used by the knowledge-repo and group-knowledge-repo entry points, which tell
 * the user the repo "must live on the internal GitHub host". Enforcing that means
 * failing CLOSED on anything whose host we cannot parse.
 *
 * It previously returned true when `gitHostFromSource` yielded null. That branch
 * was dead for `owner/repo` (handled above it), so its only real effect was to
 * admit values with NO parseable host — bare filesystem paths and `scheme::`
 * remote-helper syntax — straight past the one check meant to stop them. A path
 * like `/data/knowledge/<otherUserId>/.git` also satisfies `looksLikeRepo` (it
 * ends in `.git`), so any authenticated user could point their knowledge repo at
 * another user's clone, or at a group repo they are not a member of, and then read
 * it back through the knowledge-repo endpoints and the agent's repo/brain read
 * tools.
 *
 * Arg-safety (leading dash, remote-helper syntax) is a SEPARATE concern handled at
 * every clone path by `assertSafeGitValue` — that layer must keep accepting local
 * paths, which are a legitimate repo source for `register_repo` and the offline
 * tests. This function is the source/host POLICY gate, and only these two callers
 * impose that policy.
 */
export function isInternalGitSource(source: string, githubHost: string): boolean {
  const raw = source.trim();
  // `owner/repo` shorthand is resolved against the internal host by
  // `marketplaceCloneUrl`, so it is internal by construction.
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    return true;
  }
  const host = gitHostFromSource(raw);
  return host !== null && host === normalizeGithubHost(githubHost);
}

/**
 * Pick the token for an https clone/push URL. Shorthand repos are resolved to
 * the internal host before this function is called. Tokens are only sent to the
 * configured internal GitHub host or github.com; unknown hosts get no token.
 */
export function tokenForGitUrl(
  url: string,
  config: Pick<AppConfig, "githubHost">,
  tokens?: string | null | GitTokenSet,
): string | undefined {
  if (!/^https:\/\//i.test(url)) {
    return undefined;
  }
  const tokenSet = normalizeGitTokenInput(tokens);
  const host = gitHostFromSource(url);
  if (!host) {
    return undefined;
  }
  const internalHost = normalizeGithubHost(config.githubHost);
  if (host === internalHost) {
    return tokenSet.internal || undefined;
  }
  if (host === DEFAULT_GITHUB_HOST) {
    return tokenSet.external || undefined;
  }
  return undefined;
}
