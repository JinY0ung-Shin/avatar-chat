// Single source of truth for RESERVED secret env names — the names whose
// values have app-dedicated routing and must NEVER ride the generic injection
// paths (agent shell env / plugin MCP servers):
//  - git credentials are used server-side only ("git remote work is MCP-only
//    BY DESIGN", root CLAUDE.md) — reaching any agent-adjacent process would
//    hand out push rights;
//  - SSH material flows exclusively to the app-pinned hex-ssh subprocess.
//
// LEAF MODULE on purpose: no imports, so the Svelte client can import it
// directly (like experimentalFeatures.ts) to hide the per-secret "셸 노출"
// toggle for reserved names. The two git-token literals mirror
// INTERNAL/EXTERNAL_GIT_TOKEN_SECRET_NAME in gitCredentials.ts — a unit test
// pins them together so they can't drift.

export const GIT_CREDENTIAL_ENV_NAMES = [
  "GIT_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

export const SSH_MCP_SECRET_ENV_NAMES = [
  "SSH_PRIVATE_KEY",
  "SSH_PASSPHRASE",
  "SSH_PASSWORD",
  "SSH_USER",
  "SSH_USERNAME",
  "ALLOWED_HOSTS",
  "ALLOWED_HOST_FINGERPRINTS",
] as const;

export const RESERVED_SECRET_ENV_NAMES: ReadonlySet<string> = new Set<string>([
  ...GIT_CREDENTIAL_ENV_NAMES,
  ...SSH_MCP_SECRET_ENV_NAMES,
]);

/**
 * True when a secret name may be exposed beyond its dedicated consumer —
 * i.e. injected into the owner's plugin MCP servers and (per-key opt-in)
 * exported into the agent shell env.
 */
export function isShellExposableSecret(name: string): boolean {
  return !RESERVED_SECRET_ENV_NAMES.has(name);
}
