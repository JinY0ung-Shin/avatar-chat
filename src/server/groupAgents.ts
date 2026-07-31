import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  AvatarDetail,
  AvatarSummary,
  GroupAgent,
  GroupRole,
} from "./types.js";
import { groupKnowledgeClonePath } from "./groupKnowledgeRepo.js";
import { workspaceDirFor } from "./workspace.js";
import type { Store } from "./store.js";

/**
 * Group shared-agent helpers (id namespace, reach gate, wire projections) —
 * mirrors the externalAgents.ts helper set for the OTHER non-users avatar
 * kind. Unlike externals, a group agent runs the full local SDK stack; these
 * helpers cover only identity + discovery/reach, never the run itself.
 */

/** Namespaced public avatar id prefix — `group:<groupId>` (external:<id> precedent). */
export const GROUP_AGENT_AVATAR_PREFIX = "group:";

export function groupAgentAvatarId(groupId: string): string {
  return `${GROUP_AGENT_AVATAR_PREFIX}${groupId}`;
}

/** The owning group id, or null when `avatarId` is not a group-agent id. */
export function parseGroupAgentGroupId(avatarId: string): string | null {
  if (!avatarId.startsWith(GROUP_AGENT_AVATAR_PREFIX)) return null;
  const groupId = avatarId.slice(GROUP_AGENT_AVATAR_PREFIX.length);
  return groupId || null;
}

/**
 * Whether `role` may CAPTURE (write + commit) to the shared second brain
 * through the group agent — the ONE derivation of the capture_scope policy.
 * Direct `mcp__group_repo__` writes from personal-avatar runs stay admin-only
 * regardless; this governs group-agent runs only.
 */
export function groupAgentCaptureAllowed(
  agent: Pick<GroupAgent, "captureScope">,
  role: GroupRole,
): boolean {
  return agent.captureScope === "members" || role === "admin";
}

export interface ChattableGroupAgent {
  agent: GroupAgent;
  groupId: string;
  groupName: string;
  viewerRole: GroupRole;
}

/**
 * THE single reach gate for group agents, used by detail/skills/models/chat/
 * image alike: prefix parse → agent exists → enabled → viewer is a member of
 * the owning group. Fails closed (null) on every miss — non-members get the
 * same not-found/forbidden shape as an unknown avatar (no existence leak).
 * Reach is MEMBERSHIP-only: the group's avatar-sharing policy does not apply
 * (a knowledge-sharing-only group still reaches its shared agent), and system
 * admins do NOT bypass membership (external-avatar precedent).
 *
 * `includeDisabled` lets the chat route distinguish member-visible "disabled"
 * (dedicated 403 message) from not-found; discovery/read surfaces omit it.
 */
export function findChattableGroupAgent(
  store: Store,
  viewerId: string,
  avatarId: string,
  opts: { includeDisabled?: boolean } = {},
): ChattableGroupAgent | null {
  const groupId = parseGroupAgentGroupId(avatarId);
  if (!groupId) return null;
  const agent = store.getGroupAgent(groupId);
  if (!agent) return null;
  if (!agent.enabled && !opts.includeDisabled) return null;
  const viewerRole = store.groupRoleFor(viewerId, groupId);
  if (!viewerRole) return null;
  const group = store.getGroup(groupId);
  if (!group) return null;
  return { agent, groupId, groupName: group.name, viewerRole };
}

export function groupAgentAvatarSummary(
  agent: GroupAgent,
  groupName: string,
): AvatarSummary {
  return {
    id: groupAgentAvatarId(agent.groupId),
    username: `group-${agent.groupId}`,
    displayName: agent.displayName,
    alias: agent.alias,
    bio: agent.bio,
    hashtags: [...agent.hashtags],
    hasImage: agent.hasImage,
    pluginCount: 0,
    // Member-only reach — "group" is exact, not a compromise.
    visibility: "group",
    updatedAt: null,
    // Full local SDK stack, unlike externals: keep the native runtime so
    // external-only client branches never fire for group agents.
    runtime: "native",
    sharesGroup: false,
    groupAgent: { groupId: agent.groupId, groupName },
  };
}

export function groupAgentAvatarDetail(
  agent: GroupAgent,
  groupName: string,
): AvatarDetail {
  return {
    ...groupAgentAvatarSummary(agent, groupName),
    persona: agent.persona,
    intro: agent.intro,
    isOwn: false,
    // Members run the elevated tool class on group-agent runs (workspace
    // Bash/Edit work); owner-only tools never register. Hides the read-only chip.
    elevated: true,
    plugins: [],
  };
}

export function listGroupAgentAvatarSummaries(
  store: Store,
  viewerId: string,
): AvatarSummary[] {
  return store
    .listGroupAgentsForUser(viewerId)
    .map(({ agent, groupName }) => groupAgentAvatarSummary(agent, groupName))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Best-effort disk cleanup for a DELETED group, called by the admin route
 * AFTER `store.deleteGroup`'s transaction: the group-knowledge clone (a
 * pre-existing leak — possibly a private repo's full clone) and the group
 * agent's chat workspaces. The agent's profile-image FILE is the route's job
 * (it has the image helpers). A concurrent run holding the repo lock surfaces
 * a tool error and re-clones nothing — the group row is already gone.
 */
export function cleanupGroupDataDirs(config: AppConfig, groupId: string): void {
  const targets = [
    groupKnowledgeClonePath(groupId, config),
    // workspaceDirFor is per-conversation; its parent is the agent's tree.
    path.dirname(workspaceDirFor(config, groupAgentAvatarId(groupId), "x")),
  ];
  for (const dir of targets) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
