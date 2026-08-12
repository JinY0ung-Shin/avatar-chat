import type {
  AppConfig,
  GroupAgentState,
  UserGroupMembership,
} from "../types.js";
import { groupAgentCaptureAllowed } from "../groupAgents.js";
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
  /** Subset of `secretNames` opted into agent-shell exposure (per-key toggle). */
  shellExposedSecretNames: string[];
  /** Groups the owner belongs to, with role + shared-repo flag per group. */
  groups: UserGroupMembership[];
  /** Number of general (work/code) git repos the owner has registered. */
  gitRepoCount: number;
  /** Pending knowledge (request_info) gaps in the owner's inbox. */
  openRequestCount: number;
  /** Skills shared by visible teammates that this owner could learn (#skill-share). */
  learnableSkillCount: number;
  /** Skills this owner currently shares from their knowledge repo. */
  sharedSkillCount: number;
  /** Total times teammates learned this owner's skills (전수된 횟수, all skills). */
  sharedSkillLearnTotal: number;
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
    shellExposedSecretNames: store.listShellExposedSecretNames(avatarUserId),
    groups: store.listUserGroups(avatarUserId),
    // Lazy: only describe_system reads these; the buildPrompt/runClaudeAgent path
    // never accesses them, so defer the store queries until a consumer reads them.
    get gitRepoCount() {
      return store.listGitRepos(avatarUserId).length;
    },
    get openRequestCount() {
      return store.countOpenKnowledgeRequests(avatarUserId);
    },
    // Lazy like the counts above: read by owner-driven prompts + describe_system.
    get learnableSkillCount() {
      return store.countLearnableSkills(avatarUserId);
    },
    get sharedSkillCount() {
      return store.listSharedSkillsByOwner(avatarUserId).length;
    },
    // Lazy; only describe_system reads it (gitRepoCount precedent).
    get sharedSkillLearnTotal() {
      return store.countSkillLearnsForOwner(avatarUserId);
    },
    anthropicModel: config.anthropicModel,
    modelOverride: store.getModelOverride(),
    experimentalFeatures: store.getExperimentalFeatures(avatarUserId),
    sharedAccount: store.isSharedAccount(avatarUserId),
  };
}

/** A high-impact setup step the owner has not completed yet. */
export type GettingStartedGapId = "repo" | "gitToken";

/**
 * The owner's unfinished setup, most impactful first. Facts only — no prose and
 * no labels: `buildSystemPromptAppend` turns these ids into its standing
 * "you may offer to fix this ONCE" guidance and `describe_system` into its own
 * state line, each formatting its own way (the ownerState.ts contract above).
 *
 * Deliberately only TWO ids. Both keep whole capability families dark — with no
 * repository the avatar has no memory, no skills, and nowhere to capture; with
 * no token it can neither create a repository nor commit/push one. Counts that
 * could merely be HIGHER (secrets, plugins, shared/learnable skills, groups) are
 * not gaps: an avatar that recites everything its owner has not done yet nags.
 *
 * Takes the two flags rather than a whole OwnerState so the prompt builder can
 * call it with the same facts riding on `AgentRequest` — the derivation stays
 * HERE, at the sync point, instead of being re-implemented per consumer.
 */
export function gettingStartedGaps(
  state: Pick<OwnerState, "knowledgeRepoConfigured" | "gitTokenSet">,
): GettingStartedGapId[] {
  const gaps: GettingStartedGapId[] = [];
  if (!state.knowledgeRepoConfigured) {
    gaps.push("repo");
  }
  if (!state.gitTokenSet) {
    gaps.push("gitToken");
  }
  return gaps;
}

/**
 * Inert OwnerState for runs that have NO owner (group shared agents): every
 * user-scoped fact reads empty/false, so no personal capability can leak into
 * a gate or prompt even by accident — the group-agent run derives its actual
 * state from `summarizeGroupAgentState` below, never from this. Config-scoped
 * model facts stay real (they aren't personal).
 */
export function emptyOwnerState(store: Store, config: AppConfig): OwnerState {
  return {
    knowledgeRepoConfigured: false,
    knowledgeRepo: { repo: null, branch: null },
    gitTokenSet: false,
    secretNames: [],
    shellExposedSecretNames: [],
    groups: [],
    gitRepoCount: 0,
    openRequestCount: 0,
    learnableSkillCount: 0,
    sharedSkillCount: 0,
    sharedSkillLearnTotal: 0,
    anthropicModel: config.anthropicModel,
    modelOverride: store.getModelOverride(),
    experimentalFeatures: [],
    sharedAccount: false,
  };
}

/** Read the group agent's current self-state (`GroupAgentState`, types.ts — the
 *  group analogue of OwnerState with the same both-consumers invariant: it feeds
 *  BOTH the group-agent prompt branch AND describe_system's group ctx). Repo
 *  facts come from the GROUP row; the git token is the ACTING member's (groups
 *  own no credentials — capture pushes borrow it). Null when the agent/group is
 *  gone. */
export function summarizeGroupAgentState(
  store: Store,
  config: AppConfig,
  agentId: string,
  actingUserId: string,
): GroupAgentState | null {
  const agent = store.getGroupAgentById(agentId);
  const group = agent ? store.getGroup(agent.groupId) : null;
  if (!agent || !group) {
    return null;
  }
  const groupId = agent.groupId;
  // Live role — null once the member has been removed mid-turn. FAIL CLOSED
  // (never default to "member"): describe_system must not report capture as
  // allowed while the group-repo tools are already refusing the same user.
  const viewerRole = store.groupRoleFor(actingUserId, groupId);
  const repo = store.getGroupKnowledgeRepo(groupId);
  return {
    groupId,
    agentId: agent.id,
    displayName: agent.displayName,
    groupName: group.name,
    enabled: agent.enabled,
    captureScope: agent.captureScope,
    viewerRole,
    captureAllowed:
      viewerRole !== null && groupAgentCaptureAllowed(agent, viewerRole),
    knowledgeRepoConfigured: Boolean(repo.repo),
    knowledgeRepo: { repo: repo.repo, branch: repo.branch },
    viewerGitTokenSet: Boolean(store.getGitToken(actingUserId)),
    personaSet: Boolean(agent.persona.trim()),
    // Live membership REQUIRED even for system admins (every in-run group tool
    // fails closed on removal); the update_profile handler applies the same gate.
    selfConfigAllowed:
      viewerRole !== null &&
      (viewerRole === "admin" || store.isAdmin(actingUserId)),
    anthropicModel: config.anthropicModel,
    modelOverride: store.getModelOverride(),
  };
}
