// Browser-control allowlist pattern semantics, shared client↔server.
//
// The AUTHORITY on these semantics is the extension (`background.js`
// `originAllowed`) — a fielded, signed artifact that cannot import this module,
// so this is a hand-kept mirror: exact hostname, `*.suffix` (which matches
// sub.suffix but never the apex), or a bare `*` for everything. Keep the two in
// lockstep. Noah uses it OUTSIDE the extension for one thing: deciding whether
// a default-allowlist entry would cover Noah's own host — such an entry is
// dropped rather than shipped, because driving the logged-in Noah UI is exactly
// what the staging-page exemption was scoped down to prevent.

/** Whether one allowlist pattern would allow `hostname` (see module note). */
export function patternMatchesHost(pattern: string, hostname: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return hostname.endsWith(pattern.slice(1));
  return hostname === pattern;
}

/**
 * The subset of `patterns` safe to hand a browser as its DEFAULT allowlist:
 * anything that would cover `ownHostname` (Noah itself) is dropped — including
 * a bare `*`, which is never shippable as a default. Normalizes to trimmed
 * lowercase and dedupes, mirroring what the extension stores.
 */
export function defaultAllowlistFor(
  patterns: readonly string[],
  ownHostname: string | null,
): string[] {
  const host = (ownHostname ?? "").trim().toLowerCase();
  const out: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern || out.includes(pattern)) continue;
    if (host && patternMatchesHost(pattern, host)) continue;
    out.push(pattern);
  }
  return out;
}
