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

export function isInternalGitSource(source: string, githubHost: string): boolean {
  if (/^[\w.-]+\/[\w.-]+$/.test(source.trim())) {
    return true;
  }
  const host = gitHostFromSource(source);
  return host === null || host === normalizeGithubHost(githubHost);
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
