// Shared leading-dash arg guards for the repo clone/commit/push paths
// (knowledgeRepo.ts, groupKnowledgeRepo.ts, gitRepos.ts). A value git would read
// as an option (e.g. an identity or branch starting with "-") is a security hole,
// so these guards are intentionally identical across all three call sites — kept
// in one place rather than copy-pasted. The checks are unchanged: fall back to a
// safe default rather than fail.

/**
 * Guard a commit author identity against values git would read as options
 * (passed positionally after the config key). Falls back to safe defaults when a
 * field starts with "-".
 */
export function safeIdentity(identity: { name: string; email: string }): {
  name: string;
  email: string;
} {
  return {
    name: identity.name.startsWith("-") ? "noah-almighty" : identity.name,
    email: identity.email.startsWith("-") ? "avatar@noah-almighty.local" : identity.email,
  };
}

/**
 * Guard a push branch against a value git would read as an option. Falls back to
 * "HEAD" when the resolved branch starts with "-".
 */
export function safePushBranch(rawBranch: string): string {
  return rawBranch.startsWith("-") ? "HEAD" : rawBranch;
}
