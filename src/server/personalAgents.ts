import path from "node:path";
import type {
  AppConfig,
  AvatarDetail,
  AvatarSummary,
  PersonalAgent,
} from "./types.js";
import { workspaceDirFor } from "./workspace.js";
import type { Store } from "./store.js";

/**
 * Personal-agent (내 봇) helpers — id namespace, reach gate, wire projections —
 * mirroring groupAgents.ts for the OTHER owner-scoped non-users avatar kind.
 * Unlike a group agent, a personal agent runs with the OWNER's own capability
 * (a full owner run); these helpers cover identity + discovery/reach only,
 * never the run itself.
 */

/** Namespaced public avatar id prefix — `personal:<ownerUserId>:<agentId>`. */
export const PERSONAL_AGENT_AVATAR_PREFIX = "personal:";

/**
 * Field caps shared by EVERY writer of a personal agent's profile — the HTTP
 * settings route and the MCP tools (create_agent / update_profile) must enforce
 * the same numbers or one surface becomes a cap bypass. Values mirror
 * GROUP_AGENT_FIELD_CAPS (groupAgentProfileTools.ts).
 */
export const PERSONAL_AGENT_FIELD_CAPS = {
  persona: 8_000,
  alias: 64,
  bio: 200,
  intro: 2_000,
} as const;

/** Display-name cap for both the HTTP route and the create_agent MCP tool. */
export const PERSONAL_AGENT_DISPLAY_NAME_CAP = 64;

export function personalAgentAvatarId(
  ownerUserId: string,
  agentId: string,
): string {
  return `${PERSONAL_AGENT_AVATAR_PREFIX}${ownerUserId}:${agentId}`;
}

export interface PersonalAgentRef {
  ownerUserId: string;
  agentId: string;
}

/**
 * Parse `personal:<ownerUserId>:<agentId>`; null on anything else — a missing
 * segment, an empty one, or an extra `:` all fail closed, so a stale/forged
 * client id reads as not-found rather than half-resolving to some other bot.
 */
export function parsePersonalAgentRef(
  avatarId: string,
): PersonalAgentRef | null {
  if (!avatarId.startsWith(PERSONAL_AGENT_AVATAR_PREFIX)) return null;
  const rest = avatarId.slice(PERSONAL_AGENT_AVATAR_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const ownerUserId = rest.slice(0, sep);
  const agentId = rest.slice(sep + 1);
  if (!ownerUserId || !agentId || agentId.includes(":")) return null;
  return { ownerUserId, agentId };
}

export interface ChattablePersonalAgent {
  agent: PersonalAgent;
}

/**
 * THE single reach gate for personal agents, used by detail/skills/models/chat/
 * image alike: ref parse → bot exists under THAT owner → the viewer IS the
 * owner → the owner still holds the admin role → enabled. Fails closed (null)
 * on every miss, so a non-owner gets the same not-found shape as an unknown
 * avatar (no existence leak). Reach is OWNER-ONLY: co-membership, avatar
 * sharing and the system-admin role never widen it — an admin reaches only
 * their OWN bots. The live `isAdmin` re-check is the phase-1 feature gate: a
 * demoted owner loses the next turn while their threads stay intact (the
 * group-agent membership-loss precedent).
 *
 * `includeDisabled` lets the chat route distinguish owner-visible "disabled"
 * (dedicated 403 message) from not-found; discovery/read surfaces omit it.
 */
export function findChattablePersonalAgent(
  store: Store,
  viewerUserId: string,
  avatarId: string,
  opts: { includeDisabled?: boolean } = {},
): ChattablePersonalAgent | null {
  const ref = parsePersonalAgentRef(avatarId);
  if (!ref) return null;
  const agent = store.getPersonalAgentById(ref.agentId);
  if (!agent || agent.ownerUserId !== ref.ownerUserId) return null;
  if (viewerUserId !== agent.ownerUserId) return null;
  if (!store.isAdmin(viewerUserId)) return null;
  if (!agent.enabled && !opts.includeDisabled) return null;
  return { agent };
}

export function personalAgentAvatarSummary(agent: PersonalAgent): AvatarSummary {
  return {
    id: personalAgentAvatarId(agent.ownerUserId, agent.id),
    username: `personal-agent-${agent.id.slice(0, 8)}`,
    displayName: agent.displayName,
    alias: agent.alias,
    bio: agent.bio,
    hashtags: [...agent.hashtags],
    hasImage: agent.hasImage,
    pluginCount: 0,
    // The 2-state enum has no owner-only state, and "group" (not "private")
    // keeps the 탐색 비공개 chip off — the "내 봇" badge is the kind label.
    // Reach is enforced by findChattablePersonalAgent, never by this field.
    visibility: "group",
    updatedAt: null,
    // Full local SDK stack, unlike externals: keep the native runtime so
    // external-only client branches never fire for bots.
    runtime: "native",
    sharesGroup: false,
    personalAgent: { agentId: agent.id, defaultModel: agent.defaultModel },
  };
}

export function personalAgentAvatarDetail(agent: PersonalAgent): AvatarDetail {
  return {
    ...personalAgentAvatarSummary(agent),
    persona: agent.persona,
    intro: agent.intro,
    // Not the viewer's own avatar ROW (the owner-inbox surfaces key off isOwn).
    isOwn: false,
    // A bot turn IS an owner run — full owner capability — so the read-only
    // chip must stay hidden; this flag is the only lever for that header text.
    elevated: true,
    plugins: [],
  };
}

/** The viewer's OWN enabled bots for discovery concatenation (GET /api/avatars). */
export function listPersonalAgentAvatarSummaries(
  store: Store,
  viewerUserId: string,
): AvatarSummary[] {
  if (!store.isAdmin(viewerUserId)) return [];
  return store
    .listPersonalAgents(viewerUserId)
    .map((agent) => personalAgentAvatarSummary(agent))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The bot's per-conversation workspace parent (safeSegment of its avatar id). */
export function personalAgentWorkspaceParent(
  config: AppConfig,
  agent: Pick<PersonalAgent, "id" | "ownerUserId">,
): string {
  // workspaceDirFor is per-conversation; its parent is the bot's tree.
  return path.dirname(
    workspaceDirFor(
      config,
      personalAgentAvatarId(agent.ownerUserId, agent.id),
      "x",
    ),
  );
}
