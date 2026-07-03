import type { AppConfig, UserGroupMembership } from "../types.js";
import type { Store } from "../store.js";

/**
 * Structured, UNFORMATTED snapshot of an avatar owner's current system self-state.
 *
 * The root CLAUDE.md mandates that buildPrompt's owner self-state (claudeAgent.ts)
 * and the `describe_system` tool (systemTools.ts) report the SAME runtime facts.
 * This is the single place that reads those facts from the live `store` + `config`
 * so the two call sites can't drift in WHAT they read; each caller still FORMATS
 * the data its own way (buildPrompt → English prompt paragraphs, gated by
 * ownerToolAccess; describe_system → its tool-result text). Returning raw data
 * only — never formatted strings — keeps both existing outputs byte-identical.
 *
 * NOTE on gating: this returns the ungated facts (e.g. full `secretNames`/
 * `groups`). buildPrompt blanks `secretNames`/`groupMemberships` to `[]` unless
 * `ownerToolAccess`; describe_system always reads them live (it only runs for the
 * owner). That gating stays at the call sites, not here.
 *
 * NOTE on Confluence: the two sites compute `confluencePatConfigured` from
 * DIFFERENT sources (buildPrompt from the actual decrypted secret VALUES it
 * already holds; describe_system from secret-NAME presence). This module exposes
 * `secretNames` only and leaves the Confluence derivation to each caller, so
 * neither output changes.
 *
 * NOTE on model: this exposes the raw resolution inputs (`anthropicModel` env pin,
 * `modelOverride` admin setting) — env pin > admin override > SDK default — not a
 * formatted label, since describe_system renders its own label and buildPrompt
 * does not surface the model at all.
 */
export interface OwnerState {
  /** Whether the owner has connected a personal knowledge repo (repo set). */
  knowledgeRepoConfigured: boolean;
  /** Raw knowledge-repo connection (null when none); describe_system shows `@ branch`. */
  knowledgeRepo: { repo: string | null; branch: string | null };
  /** Whether the internal GIT_TOKEN is stored. */
  gitTokenSet: boolean;
  /** Names of the owner's configured secret-tab env vars (values never included). */
  secretNames: string[];
  /** Groups the owner belongs to, with role + shared-repo flag per group. */
  groups: UserGroupMembership[];
  /** Number of general (work/code) git repos the owner has registered. */
  gitRepoCount: number;
  /** Pending knowledge (request_info) gaps in the owner's inbox. */
  openRequestCount: number;
  /** Env-pinned model (`ANTHROPIC_MODEL`); wins over the admin override. */
  anthropicModel?: string;
  /** Admin-selected model override; used when no env pin is set. */
  modelOverride: string | null;
  /** Experimental (beta) feature keys the owner enabled for this avatar (#50). */
  experimentalFeatures: string[];
  /**
   * Shared (communal) account flag: trusted same-group teammates may also WRITE
   * to the owner's personal knowledge repo (see repoTools.ts `writeAccess`).
   */
  sharedAccount: boolean;
}

/**
 * Read the owner's current system self-state from the live store + config.
 * Pure read — no mutation. `avatarUserId` is the avatar's own user id (== owner).
 */
export function summarizeOwnerState(
  store: Store,
  config: AppConfig,
  avatarUserId: string,
): OwnerState {
  const knowledgeRepo = store.getKnowledgeRepo(avatarUserId);
  return {
    knowledgeRepoConfigured: Boolean(knowledgeRepo.repo),
    knowledgeRepo: { repo: knowledgeRepo.repo, branch: knowledgeRepo.branch },
    gitTokenSet: Boolean(store.getGitToken(avatarUserId)),
    secretNames: store.listUserSecretNames(avatarUserId),
    groups: store.listUserGroups(avatarUserId),
    // Lazy: only describe_system reads these; the buildPrompt/runClaudeAgent path
    // never accesses them, so defer the store queries until a consumer reads them.
    get gitRepoCount() {
      return store.listGitRepos(avatarUserId).length;
    },
    get openRequestCount() {
      return store.countOpenKnowledgeRequests(avatarUserId);
    },
    anthropicModel: config.anthropicModel,
    modelOverride: store.getModelOverride(),
    experimentalFeatures: store.getExperimentalFeatures(avatarUserId),
    sharedAccount: store.isSharedAccount(avatarUserId),
  };
}
