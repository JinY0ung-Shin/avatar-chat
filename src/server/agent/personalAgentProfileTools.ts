import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import { MAX_PERSONAL_AGENTS } from "../store.js";
import type { AgentOwner } from "../types.js";
import {
  PERSONAL_AGENT_DISPLAY_NAME_CAP,
  PERSONAL_AGENT_FIELD_CAPS,
} from "../personalAgents.js";
import { text } from "./mcpTools.js";

/**
 * Personal-agent (내 봇) tools — the OWNER-scoped counterpart of
 * groupAgentProfileTools.ts, split over the two run kinds that can reach them:
 *
 * - `update_profile` registers only on a PERSONAL-AGENT run: the bot edits its
 *   OWN persona/profile mid-conversation (the group agent's self-configuration,
 *   scoped to one person's bot instead of a team's).
 * - `create_agent` registers only on a NON-bot owner run: the owner's main
 *   avatar stands a new bot up for them.
 *
 * Both are gated per call on the LIVE owner + admin role (the phase-1 feature
 * gate), because the `mcp__` auto-allow in the PreToolUse hook fires before any
 * check. Field caps and the cap-vs-name throws are NOT re-derived here — they
 * come from `../personalAgents.js` and the store, the single enforcement points
 * the HTTP settings route shares. State surfaces via `PersonalAgentState`
 * (ownerState.ts) into BOTH the prompt branch and describe_system.
 */

/** MCP server name; tools surface as `mcp__personal_agent__<tool>`. */
export const PERSONAL_AGENT_SERVER_NAME = "personal_agent";

/** Bot-run tool names in `allowedTools` form (keep in sync with the factory). */
export const PERSONAL_AGENT_SELF_TOOL_NAMES = [
  "mcp__personal_agent__update_profile",
] as const;

/** Owner-run (non-bot) tool names in `allowedTools` form. */
export const PERSONAL_AGENT_OWNER_TOOL_NAMES = [
  "mcp__personal_agent__create_agent",
] as const;

// Re-exported for symmetry with GROUP_AGENT_FIELD_CAPS: every writer of a bot
// profile (this module, the settings route) enforces the SAME numbers, and they
// are DEFINED in ../personalAgents.js next to the id/reach helpers.
export { PERSONAL_AGENT_DISPLAY_NAME_CAP, PERSONAL_AGENT_FIELD_CAPS };

const AGENT_GONE =
  "This bot no longer exists — its owner deleted it. Tell the owner instead of retrying.";
const NOT_OWNER =
  "This bot belongs to a different user, so you cannot change its profile.";
const AGENT_DISABLED =
  "This bot is currently DISABLED in its owner's settings (설정 → 내 봇), so its profile cannot be changed. Ask the owner to re-enable it first.";
const ADMIN_FEATURE_OFF =
  "Personal bots (내 봇) are an administrator-only feature in this deployment and this owner no longer holds the admin role, so bot management is unavailable. Say so plainly — there is no other route.";
const EMPTY_PATCH =
  "Provide at least one field to update (persona, alias, bio, or intro).";

const FIELD_CAPS = PERSONAL_AGENT_FIELD_CAPS;
type ProfileField = keyof typeof FIELD_CAPS;
const PROFILE_FIELDS = Object.keys(FIELD_CAPS) as ProfileField[];

/** `Provide at least one…`-style cap refusal, shared by both tools. */
function overCap(field: string, cap: number, length: number): string {
  return `The ${field} field is limited to ${cap} characters (got ${length}). Shorten it and try again.`;
}

/** Context for ONE personal-agent run's self-configuration tool. */
export interface PersonalAgentSelfToolsContext {
  /** WHICH bot this run is; ownership/enabled/role are re-read per call. */
  agentId: string;
  /** The owner driving this run: live gate subject AND audit actor. */
  owner: AgentOwner;
}

/** Context for an owner's own (non-bot) run, which may CREATE bots. */
export interface PersonalAgentOwnerToolsContext {
  /** The avatar owner: live gate subject AND audit actor. */
  owner: AgentOwner;
}

/**
 * The bot's own profile tool, exposed separately from the server so tests can
 * exercise the handler directly (the sibling group factories' pattern).
 */
export function buildPersonalAgentSelfTools(
  store: Store,
  ctx: PersonalAgentSelfToolsContext,
) {
  return [
    tool(
      "update_profile",
      `**Use this tool when your owner asks you to change your role, persona, or profile** (e.g. "from now on you are my release-notes bot"). It updates THIS bot — you — for every future conversation the owner has with you, so CONFIRM the wording with them before calling; never change your own persona unprompted. Changes take effect from the NEXT turn (this turn keeps running on the current profile). Omitted fields keep their value; pass an empty string to clear one. (this bot's owner only)`,
      {
        persona: z
          .string()
          .optional()
          .describe(
            "New persona / standing instructions: the role, tone, and priorities you should follow in every conversation with this owner.",
          ),
        alias: z
          .string()
          .optional()
          .describe("What you call yourself in chat (max 64 chars)."),
        bio: z
          .string()
          .optional()
          .describe("One-line description shown in discovery (max 200 chars)."),
        intro: z
          .string()
          .optional()
          .describe(
            "Self-introduction shown in the avatar introduction dialog on the explore page.",
          ),
      },
      async (args) => {
        // Live per-call gate (the mcp__ auto-allow fires before any check): a
        // deleted bot, a disabled one, and an owner whose admin role was revoked
        // mid-conversation all refuse, matching the reach gate that will refuse
        // the next turn (findChattablePersonalAgent).
        const agent = store.getPersonalAgentById(ctx.agentId);
        if (!agent) return text(AGENT_GONE, true);
        if (agent.ownerUserId !== ctx.owner.id) return text(NOT_OWNER, true);
        if (!agent.enabled) return text(AGENT_DISABLED, true);
        if (!store.isAdmin(ctx.owner.id)) return text(ADMIN_FEATURE_OFF, true);
        const patch: Partial<Record<ProfileField, string>> = {};
        for (const field of PROFILE_FIELDS) {
          const value = args[field];
          if (value === undefined) continue;
          if (value.length > FIELD_CAPS[field]) {
            return text(overCap(field, FIELD_CAPS[field], value.length), true);
          }
          patch[field] = value;
        }
        const changed = Object.keys(patch);
        if (changed.length === 0) return text(EMPTY_PATCH, true);
        // displayName is never patched here, so the store's name throw is
        // unreachable; null = the bot was deleted between the read and now.
        const updated = store.updatePersonalAgent(ctx.agentId, patch);
        if (!updated) return text(AGENT_GONE, true);
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "personal_agent_update",
          status: "success",
          detail: `agent=${ctx.agentId} self-config via update_profile (${changed.join(", ")})`,
        });
        return text(
          `Updated your ${changed.join(", ")}. The change applies to every future conversation with this bot and takes effect from the NEXT turn — this turn still runs on the previous profile.`,
        );
      },
    ),
  ];
}

/** The owner's bot-creation tool (non-bot owner runs), exposed for tests. */
export function buildPersonalAgentOwnerTools(
  store: Store,
  ctx: PersonalAgentOwnerToolsContext,
) {
  return [
    tool(
      "create_agent",
      `**Use this tool when the owner asks you to create a new personal bot / teammate of their own** (e.g. "make me a bot that only does release notes", "내 봇 하나 만들어줘"). It creates a NEW chat contact owned by them — a separate conversation partner with its own name and persona, running with the owner's own capability — and it becomes chattable immediately. Ask for the name first if they did not give one; up to ${MAX_PERSONAL_AGENTS} bots per owner. Editing an existing bot is NOT done here: the owner edits it in 설정 → 내 봇, or asks the bot itself in ITS conversation. (owner only, administrators only)`,
      {
        display_name: z
          .string()
          .describe(
            `The bot's name, as the owner wants it listed (max ${PERSONAL_AGENT_DISPLAY_NAME_CAP} chars). Required.`,
          ),
        alias: z
          .string()
          .optional()
          .describe("What the bot calls itself in chat (max 64 chars)."),
        bio: z
          .string()
          .optional()
          .describe("One-line description shown in discovery (max 200 chars)."),
        intro: z
          .string()
          .optional()
          .describe(
            "Self-introduction shown in the avatar introduction dialog on the explore page.",
          ),
        persona: z
          .string()
          .optional()
          .describe(
            "Persona / standing instructions for the new bot: role, tone, priorities. Draft it from what the owner described.",
          ),
      },
      async (args) => {
        // Live admin re-check: registration is not the boundary (the mcp__
        // auto-allow), and the role can be revoked mid-conversation.
        if (!store.isAdmin(ctx.owner.id)) return text(ADMIN_FEATURE_OFF, true);
        const displayName = args.display_name.trim();
        if (!displayName) {
          return text(
            "The bot needs a name — ask the owner what to call it, then call this again with display_name.",
            true,
          );
        }
        if (displayName.length > PERSONAL_AGENT_DISPLAY_NAME_CAP) {
          return text(
            overCap(
              "display_name",
              PERSONAL_AGENT_DISPLAY_NAME_CAP,
              displayName.length,
            ),
            true,
          );
        }
        const profile: Partial<Record<ProfileField, string>> = {};
        for (const field of PROFILE_FIELDS) {
          const value = args[field];
          if (value === undefined) continue;
          if (value.length > FIELD_CAPS[field]) {
            return text(overCap(field, FIELD_CAPS[field], value.length), true);
          }
          profile[field] = value;
        }
        try {
          const agent = store.createPersonalAgent(ctx.owner.id, {
            displayName,
            ...profile,
          });
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "personal_agent_create",
            status: "success",
            detail: `agent=${agent.id} (${agent.displayName}) via create_agent`,
          });
          return text(
            `Created the personal bot "${agent.displayName}"${agent.alias ? ` (alias "${agent.alias}")` : ""} — id ${agent.id}. ` +
              `The owner now has ${store.countPersonalAgents(ctx.owner.id)} of ${MAX_PERSONAL_AGENTS} bots. ` +
              "Tell them it is chattable RIGHT NOW: it appears in 탐색 and in the '내 봇' section of the left rail, and opening it starts a conversation with the new bot. " +
              (profile.persona
                ? "Its persona is already set; to change it later they can ask the bot itself in its own conversation, or edit it in 설정 → 내 봇."
                : "It has no persona yet — they can give it one by asking the bot itself in its own conversation, or in 설정 → 내 봇."),
          );
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (code === "PERSONAL_AGENT_LIMIT") {
            return text(
              `The owner already has the maximum of ${MAX_PERSONAL_AGENTS} personal bots, so no new one can be created. Suggest they delete or repurpose one in 설정 → 내 봇 first.`,
              true,
            );
          }
          if (code === "INVALID_PERSONAL_AGENT_NAME") {
            return text(
              "The bot needs a non-empty name — ask the owner what to call it, then call this again with display_name.",
              true,
            );
          }
          throw error;
        }
      },
    ),
  ];
}

/** Build the in-process MCP server for a PERSONAL-AGENT run's self-configuration. */
export function buildPersonalAgentSelfServer(
  store: Store,
  ctx: PersonalAgentSelfToolsContext,
) {
  return createSdkMcpServer({
    name: PERSONAL_AGENT_SERVER_NAME,
    version: "0.1.0",
    tools: buildPersonalAgentSelfTools(store, ctx),
  });
}

/**
 * Build the in-process MCP server for an OWNER run's bot creation. Shares the
 * server NAME with the self server above — the two never coexist (one needs a
 * bot run, the other a non-bot run; see runPlan's mutually exclusive gates).
 */
export function buildPersonalAgentOwnerServer(
  store: Store,
  ctx: PersonalAgentOwnerToolsContext,
) {
  return createSdkMcpServer({
    name: PERSONAL_AGENT_SERVER_NAME,
    version: "0.1.0",
    tools: buildPersonalAgentOwnerTools(store, ctx),
  });
}
