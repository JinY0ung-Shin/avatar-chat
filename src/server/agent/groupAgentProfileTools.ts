import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import { text } from "./mcpTools.js";

/**
 * Self-configuration tools for a GROUP SHARED-AGENT run — the agent updates its
 * OWN persona/profile mid-conversation (the first self-configuration tool in
 * the system; personal avatars have no equivalent). Registered ONLY on
 * group-agent runs and gated per call on the ACTING member's LIVE group-admin
 * role, mirroring the settings route's `canManageGroup` (group admin OR system
 * admin) — but membership stays REQUIRED like every other in-run group tool.
 * State surfaces via `GroupAgentState.personaSet`/`selfConfigAllowed`
 * (ownerState.ts), consumed by the prompt branch AND describe_system.
 */

/** Context for one group-agent run's self-configuration tools. */
export interface GroupAgentProfileToolsContext {
  groupId: string;
  /** WHICH shared agent this run is; enabled flag is re-read per call. */
  agentId: string;
  groupName: string;
  /** The acting member: live role gate + audit actor. */
  actingUser: { id: string; username: string; displayName: string };
}

/** MCP server name; tools surface as `mcp__group_agent__<tool>`. */
export const GROUP_AGENT_PROFILE_SERVER_NAME = "group_agent";

/** Tool names in `allowedTools` form (keep in sync with the factory below). */
export const GROUP_AGENT_PROFILE_TOOL_NAMES = [
  "mcp__group_agent__update_profile",
] as const;

const AGENT_DISABLED =
  "This shared group agent has been disabled by a group admin.";
const NOT_A_MEMBER =
  "You are no longer a member of this group, so its shared tools are unavailable.";
const ADMIN_ONLY =
  "Only group ADMINS may reconfigure this shared agent. Draft the wording the member wants and suggest they ask a group admin (admins can also edit it in group settings).";
const EMPTY_PATCH =
  "Provide at least one field to update (persona, alias, bio, or intro).";

/**
 * Length caps: alias/bio mirror the settings-UI input limits; the free-text
 * fields get generous but bounded caps so a runaway generation cannot balloon
 * the row (persona is injected into every future turn's prompt).
 */
// Exported so the HTTP group-agent routes (routes/groups.ts) enforce the SAME
// caps as this MCP self-config tool — otherwise the admin HTTP path bypasses
// them and a multi-MB persona lands in every member's prompt each turn.
export const GROUP_AGENT_FIELD_CAPS = { persona: 8_000, alias: 64, bio: 200, intro: 2_000 } as const;
const FIELD_CAPS = GROUP_AGENT_FIELD_CAPS;
type ProfileField = keyof typeof FIELD_CAPS;
const PROFILE_FIELDS = Object.keys(FIELD_CAPS) as ProfileField[];

/**
 * Build the self-configuration tool definitions (exposed separately from the
 * server so tests can exercise the handler directly, like the sibling group
 * tool factories).
 */
export function buildGroupAgentProfileTools(
  store: Store,
  ctx: GroupAgentProfileToolsContext,
) {
  return [
    tool(
      "update_profile",
      `**Use this tool when a group ADMIN asks you to change your role, persona, or profile** (e.g. "from now on, act as the team's code-review gatekeeper"). It updates THIS shared agent of the '${ctx.groupName}' group for EVERY member's conversations — confirm that team-wide effect with the member BEFORE calling. Changes take effect from the NEXT turn (this turn keeps running on the current profile). Omitted fields keep their value; pass an empty string to clear one. (group admin only)`,
      {
        persona: z
          .string()
          .optional()
          .describe(
            "New persona / standing instructions: role, tone, priorities the agent should follow in every member's conversations.",
          ),
        alias: z
          .string()
          .optional()
          .describe("What the agent calls itself in chat (max 64 chars)."),
        bio: z
          .string()
          .optional()
          .describe("One-line description shown in discovery (max 200 chars)."),
        intro: z
          .string()
          .optional()
          .describe("Self-introduction shown in the capabilities panel."),
      },
      async (args) => {
        // Live per-call gate (the mcp__ auto-allow fires before any check):
        // disabled agent / removed member / demoted admin all refuse
        // mid-conversation, matching the group repo/brain tools.
        const agent = store.getGroupAgentById(ctx.agentId);
        if (!agent || agent.groupId !== ctx.groupId || !agent.enabled) {
          return text(AGENT_DISABLED, true);
        }
        const role = store.groupRoleFor(ctx.actingUser.id, ctx.groupId);
        if (!role) return text(NOT_A_MEMBER, true);
        if (role !== "admin" && !store.isAdmin(ctx.actingUser.id)) {
          return text(ADMIN_ONLY, true);
        }
        const patch: Partial<Record<ProfileField, string>> = {};
        for (const field of PROFILE_FIELDS) {
          const value = args[field];
          if (value === undefined) continue;
          if (value.length > FIELD_CAPS[field]) {
            return text(
              `The ${field} field is limited to ${FIELD_CAPS[field]} characters (got ${value.length}). Shorten it and try again.`,
              true,
            );
          }
          patch[field] = value;
        }
        const changed = Object.keys(patch);
        if (changed.length === 0) return text(EMPTY_PATCH, true);
        // displayName is never patched here, so the store's only throw
        // (INVALID_GROUP_AGENT_NAME) is unreachable; null = deleted mid-run.
        const updated = store.updateGroupAgent(ctx.agentId, patch);
        if (!updated) return text(AGENT_DISABLED, true);
        store.audit({
          actorUserId: ctx.actingUser.id,
          actorName: ctx.actingUser.username,
          action: "group_agent_update",
          status: "success",
          detail: `group=${ctx.groupName} agent=${ctx.agentId} self-config via update_profile (${changed.join(", ")})`,
        });
        return text(
          `Updated this shared agent's ${changed.join(", ")}. The change applies to EVERY group member's conversations with this agent and takes effect from the NEXT turn — this turn still runs on the previous profile.`,
        );
      },
    ),
  ];
}

/** Build the in-process MCP server for a GROUP-AGENT run's self-configuration. */
export function buildGroupAgentProfileServer(
  store: Store,
  ctx: GroupAgentProfileToolsContext,
) {
  return createSdkMcpServer({
    name: GROUP_AGENT_PROFILE_SERVER_NAME,
    version: "0.1.0",
    tools: buildGroupAgentProfileTools(store, ctx),
  });
}
