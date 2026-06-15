import type { Loader } from "vega";

const VEGA_URL_BLOCKED_MESSAGE =
  "Vega canvas specs must inline data with data.values; URL-backed data, images, and links are not allowed.";

type VegaLoaderFactory = {
  loader: () => Loader;
};

function blockedVegaUrl(uri: string): Error {
  return new Error(`${VEGA_URL_BLOCKED_MESSAGE} Blocked URI: ${uri}`);
}

function findUriKey(value: unknown, path: string[] = []): string | null {
  if (!value || typeof value !== "object") return null;

  // Inline row objects commonly have fields named "url"; those are data, not
  // loader instructions. If they are later used as image/link channels, the
  // channel key outside `values` is still caught.
  if (path.includes("values") || path.includes("datasets")) return null;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findUriKey(value[i], [...path, String(i)]);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "url" || key === "href") {
      return [...path, key].join(".");
    }
    const found = findUriKey(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

export function assertInlineOnlyVegaSpec(spec: unknown): void {
  const uriPath = findUriKey(spec);
  if (uriPath) {
    throw new Error(`${VEGA_URL_BLOCKED_MESSAGE} Remove '${uriPath}' and use inline values instead.`);
  }
}

/**
 * Canvas Vega specs are avatar-controlled. Keep rendering declarative and local:
 * no data.url fetches, no URI-backed images, no URI-backed links.
 */
export function createInlineOnlyVegaLoader(vega: VegaLoaderFactory): Loader {
  const loader = vega.loader();
  const reject = async (uri: string): Promise<string> => {
    throw blockedVegaUrl(uri);
  };
  const rejectSanitize = async (uri: string): Promise<{ href: string }> => {
    throw blockedVegaUrl(uri);
  };

  loader.load = reject;
  loader.http = reject;
  loader.file = reject;
  loader.sanitize = rejectSanitize;
  return loader;
}
