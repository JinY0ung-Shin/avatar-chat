import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig, Plugin, RoutineJob } from "../types.js";

/**
 * Per-conversation context for avatar-system management tools. These tools let
 * the avatar inspect and change its own platform settings, but only when the
 * avatar owner is present or an owner-scheduled routine is running with owner
 * tool access.
 */
export interface SystemToolsContext {
  /** The avatar (== owner) whose settings these tools manage. */
  avatarUserId: string;
  /** The avatar owner, used for audit attribution. */
  owner: { id: string; username: string; displayName: string; alias?: string };
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__system__<tool>`. */
export const SYSTEM_SERVER_NAME = "system";

/** Tool names the model may call, in `allowedTools` form. */
export const SYSTEM_TOOL_NAMES = [
  "mcp__system__describe_system",
  "mcp__system__notify_user",
  "mcp__system__list_routines",
  "mcp__system__create_routine",
  "mcp__system__update_routine",
  "mcp__system__delete_routine",
  "mcp__system__list_plugins",
  "mcp__system__add_plugin",
  "mcp__system__set_plugin_enabled",
] as const;

const OWNER_ONLY = "This tool can only be used in a conversation the avatar owner is participating in.";

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function parseTimeToMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

function looksLikeRepo(value: string): boolean {
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return true;
  }
  return /^https?:\/\//.test(value) || /^git@/.test(value) || value.endsWith(".git");
}

function renderRoutine(job: RoutineJob): string {
  return [
    `id=${job.id}`,
    `time=${job.time} KST`,
    `enabled=${job.enabled ? "true" : "false"}`,
    `prompt=${JSON.stringify(job.prompt)}`,
    job.nextRunAt ? `nextRunAt=${job.nextRunAt}` : "nextRunAt=null",
    job.lastStatus ? `lastStatus=${job.lastStatus}` : "lastStatus=null",
  ].join(" | ");
}

function renderPlugin(plugin: Plugin): string {
  return [
    `id=${plugin.id}`,
    `repo=${plugin.repo}`,
    plugin.label ? `label=${JSON.stringify(plugin.label)}` : "label=null",
    plugin.ref ? `ref=${plugin.ref}` : "ref=null",
    `enabled=${plugin.enabled ? "true" : "false"}`,
    plugin.lastSyncedAt ? `lastSyncedAt=${plugin.lastSyncedAt}` : "lastSyncedAt=null",
  ].join(" | ");
}

function actor(ctx: SystemToolsContext) {
  return {
    actorUserId: ctx.owner.id,
    actorName: ctx.owner.username,
  };
}

/**
 * Build system-management tool definitions bound to a single conversation.
 * Handler-level owner gating is the safety boundary; the SDK may see the tool
 * names, but non-owner/headless calls get a refusal result.
 */
export function buildSystemTools(store: Store, ctx: SystemToolsContext) {
  return [
    tool(
      "describe_system",
      "Summarizes the current avatar system's structure and the settings this avatar can manage. For the owner, it includes the current state (profile visibility, intro, hashtags; knowledge repository; general git repos; groups and roles; secret names; whether SSH is enabled; plugins; routines; pending information requests). When asked about your own settings or state, call this tool first instead of guessing.",
      {},
      async () => {
        const user = store.getUserById(ctx.avatarUserId);
        const publicGuide = [
          "Noah Almighty avatar-chat system summary:",
          "- The avatar converses by loading its profile/persona, base skills, owner plugins, and personal knowledge repository together.",
          "- The knowledge repository is a personal repo where the avatar can directly create and commit files and skills.",
          "- Plugins are added via a GitHub repo or git URL and load starting from the next conversation.",
          "- Routines run headlessly every day at a specified time in KST, work with the same tool permissions as the owner, and leave their results in the routines tab.",
          "- Secret values are not exposed; only their names are revealed to the avatar.",
          "- Remote git operations (clone/push, etc.) are performed only through dedicated MCP tools. The shell has no git credentials.",
        ];
        if (!ctx.viewerIsOwner) {
          return text(
            `${publicGuide.join("\n")}\n\nThe current conversation partner is not the owner, so changes to plugin/routine/knowledge-repository settings cannot be made.`,
          );
        }
        const plugins = store.listPlugins(ctx.avatarUserId);
        const routines = store.listRoutineJobs(ctx.avatarUserId);
        const knowledgeRepo = store.getKnowledgeRepo(ctx.avatarUserId);
        const gitRepos = store.listGitRepos(ctx.avatarUserId);
        const secretNames = store.listUserSecretNames(ctx.avatarUserId);
        const groups = user?.groups ?? store.listUserGroups(ctx.avatarUserId);
        const openRequests = store.countOpenKnowledgeRequests(ctx.avatarUserId);
        // Mirrors the runtime's model resolution (claudeAgent: env pin > admin
        // override > SDK default) so the avatar reports the model it ACTUALLY
        // runs with, not just the env value.
        const adminModel = store.getModelOverride();
        const modelLine = ctx.config.anthropicModel
          ? `${ctx.config.anthropicModel} (pinned via environment variable)`
          : adminModel
            ? `${adminModel} (admin setting)`
            : "(SDK default)";
        const hashtags = user?.hashtags ?? [];
        const visibilityLabel =
          user?.visibility === "public"
            ? "public (discoverable by everyone)"
            : user?.visibility === "private"
              ? "private (owner only)"
              : "group (discoverable by group teammates only)";
        const lines = [
          ...publicGuide,
          "",
          "Current avatar state:",
          `- Name: ${user?.alias || user?.displayName || ctx.owner.displayName}`,
          `- Profile visibility: ${visibilityLabel}; intro ${user?.intro?.trim() ? "set" : "(none)"}, capability hashtags ${hashtags.length ? hashtags.map((t) => `#${t}`).join(" ") : "(none)"}`,
          `- runtime: ${ctx.config.agentRuntime}`,
          `- Model in use: ${modelLine}`,
          `- maxTurns: ${ctx.config.maxTurns}`,
          `- Confluence host: ${ctx.config.confluenceUrl ? "set" : "(none)"}`,
          `- Confluence PAT: ${secretNames.includes("CONFLUENCE_PAT") || secretNames.includes("CONFLUENCE_PERSONAL_ACCESS_TOKEN") ? "secret set" : "(none)"}`,
          `- Knowledge repository: ${knowledgeRepo.repo || "(none)"}${knowledgeRepo.branch ? ` @ ${knowledgeRepo.branch}` : ""}`,
          `- General git repos: ${gitRepos.length}`,
          `- Internal Git token (GIT_TOKEN): ${store.getGitToken(ctx.avatarUserId) ? "set" : "not set"}`,
          `- Secret names: ${secretNames.length ? secretNames.map((name) => `\`${name}\``).join(", ") : "(none)"}`,
          `- Remote SSH tools: ${secretNames.includes("SSH_PRIVATE_KEY") ? "enabled (SSH_PRIVATE_KEY set)" : "disabled (no SSH_PRIVATE_KEY secret)"}`,
          `- Groups: ${groups.length ? groups.map((g) => `${g.name}(${g.role === "admin" ? "admin" : "member"}, shared repository ${g.knowledgeRepoConfigured ? "connected" : "none"})`).join(", ") : "(none)"} — members of the same group automatically trust each other mutually (this is the ONLY source of elevated access; manage trust by managing group membership).`,
          `- Plugins: ${plugins.length} (${plugins.filter((p) => p.enabled).length} enabled)`,
          `- Routines: ${routines.length} (${routines.filter((r) => r.enabled).length} enabled)`,
          `- Pending information requests: ${openRequests}${openRequests > 0 ? " (use pending_requests to view the details)" : ""}`,
        ];
        return text(lines.join("\n"));
      },
    ),
    tool(
      "notify_user",
      "Sends an in-app notification message to the avatar owner. Use this to separately notify the user of important results during a routine run, items requiring action, detected failures, and so on. (owner / owner routine only)",
      {
        title: z.string().optional().describe("Notification title. Defaults to 'Avatar notification' if empty."),
        message: z.string().describe("Notification body to show the user"),
        conversationId: z.string().optional().describe("Related conversation ID. If empty, only the notification is left."),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        try {
          const notification = store.addAvatarNotification(ctx.avatarUserId, {
            avatarUserId: ctx.avatarUserId,
            title: args.title,
            message: args.message,
            conversationId: args.conversationId,
          });
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "system_tool_notify_user",
            status: "success",
            detail: `notification ${notification.id}`,
          });
          return text(`Notification sent: ${notification.title}`);
        } catch (error) {
          const message = error instanceof Error && error.message === "EMPTY_NOTIFICATION"
            ? "Please enter a notification body."
            : "Failed to save the notification.";
          return text(message, true);
        }
      },
    ),
    tool(
      "list_routines",
      "Lists the owner's avatar routines. Routines run headlessly every day at a KST time and use the same tool permissions as the owner. (owner only)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const routines = store.listRoutineJobs(ctx.avatarUserId);
        if (routines.length === 0) {
          return text("There are no registered routines.");
        }
        return text(`${routines.length} registered routine(s):\n${routines.map(renderRoutine).join("\n")}`);
      },
    ),
    tool(
      "create_routine",
      "Creates a new routine task. Runs the prompt headlessly every day at time (HH:MM) in KST, and leaves the result of working with the same tool permissions as the owner in the routines tab. (owner only)",
      {
        prompt: z.string().describe("The task instruction to run daily"),
        time: z.string().describe("HH:MM in KST, e.g.: 09:30"),
        enabled: z.boolean().optional().describe("Whether to enable immediately after creation (default true)"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const prompt = args.prompt.trim();
        if (!prompt) {
          return text("Please enter a prompt.", true);
        }
        const minuteOfDay = parseTimeToMinute(args.time);
        if (minuteOfDay === null) {
          return text("time must be in HH:MM format.", true);
        }
        const routine = store.createRoutineJob(ctx.avatarUserId, {
          prompt,
          minuteOfDay,
          enabled: args.enabled,
        });
        store.audit({
          ...actor(ctx),
          action: "system_tool_create_routine",
          status: "success",
          detail: `routine ${routine.id} at ${routine.time}`,
        });
        return text(`Created the routine:\n${renderRoutine(routine)}`);
      },
    ),
    tool(
      "update_routine",
      "Updates an existing routine's prompt, time (HH:MM KST), and enabled values. (owner only)",
      {
        id: z.string().describe("id of the routine to update"),
        prompt: z.string().optional().describe("New task instruction"),
        time: z.string().optional().describe("HH:MM in KST"),
        enabled: z.boolean().optional().describe("Whether enabled"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const patch: { prompt?: string; minuteOfDay?: number; enabled?: boolean } = {};
        if (args.prompt !== undefined) {
          const prompt = args.prompt.trim();
          if (!prompt) {
            return text("Please enter a prompt.", true);
          }
          patch.prompt = prompt;
        }
        if (args.time !== undefined) {
          const minuteOfDay = parseTimeToMinute(args.time);
          if (minuteOfDay === null) {
            return text("time must be in HH:MM format.", true);
          }
          patch.minuteOfDay = minuteOfDay;
        }
        if (args.enabled !== undefined) {
          patch.enabled = args.enabled;
        }
        if (Object.keys(patch).length === 0) {
          return text("At least one of the values to update (prompt, time, enabled) is required.", true);
        }
        const routine = store.updateRoutineJob(ctx.avatarUserId, args.id, patch);
        if (!routine) {
          return text("Routine not found.", true);
        }
        store.audit({
          ...actor(ctx),
          action: "system_tool_update_routine",
          status: "success",
          detail: `routine ${routine.id}`,
        });
        return text(`Updated the routine:\n${renderRoutine(routine)}`);
      },
    ),
    tool(
      "delete_routine",
      "Deletes an existing routine. (owner only)",
      { id: z.string().describe("id of the routine to delete") },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        if (!store.deleteRoutineJob(ctx.avatarUserId, args.id)) {
          return text("Routine not found.", true);
        }
        store.audit({
          ...actor(ctx),
          action: "system_tool_delete_routine",
          status: "success",
          detail: `routine ${args.id}`,
        });
        return text(`Deleted the routine: ${args.id}`);
      },
    ),
    tool(
      "list_plugins",
      "Lists the plugins registered to the owner's avatar. (owner only)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const plugins = store.listPlugins(ctx.avatarUserId);
        if (plugins.length === 0) {
          return text("There are no registered plugins.");
        }
        return text(`${plugins.length} registered plugin(s):\n${plugins.map(renderPlugin).join("\n")}`);
      },
    ),
    tool(
      "add_plugin",
      "Adds a GitHub/git-repo plugin to the avatar. repo accepts owner/repo, an https URL, a git@ URL, or a .git URL. The added plugin loads starting from the next conversation. (owner only)",
      {
        repo: z.string().describe("owner/repo or a git/https URL"),
        ref: z.string().optional().describe("branch/tag/commit ref (optional)"),
        label: z.string().optional().describe("display name (optional)"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const repo = args.repo.trim();
        if (!repo || !looksLikeRepo(repo)) {
          return text("repo must be in owner/repo or git/https URL format.", true);
        }
        const plugin = store.addPlugin(ctx.avatarUserId, {
          repo,
          ref: args.ref?.trim() || undefined,
          label: args.label?.trim() || undefined,
        });
        store.audit({
          ...actor(ctx),
          action: "system_tool_add_plugin",
          status: "success",
          detail: plugin.repo,
        });
        return text(
          `Added the plugin:\n${renderPlugin(plugin)}\n\nIt may not load immediately in the current conversation. It loads as an active plugin starting from the next conversation.`,
        );
      },
    ),
    tool(
      "set_plugin_enabled",
      "Enables or disables a registered plugin. The change is reflected in the load state starting from the next conversation. (owner only)",
      {
        id: z.string().describe("plugin id"),
        enabled: z.boolean().describe("whether enabled"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const plugin = store.setPluginEnabled(ctx.avatarUserId, args.id, args.enabled);
        if (!plugin) {
          return text("Plugin not found.", true);
        }
        store.audit({
          ...actor(ctx),
          action: "system_tool_set_plugin_enabled",
          status: "success",
          detail: `${plugin.repo} enabled=${plugin.enabled}`,
        });
        return text(`Changed the plugin state:\n${renderPlugin(plugin)}`);
      },
    ),
  ];
}

/** Build the in-process MCP server exposing avatar-system management tools. */
export function buildSystemServer(store: Store, ctx: SystemToolsContext) {
  return createSdkMcpServer({
    name: SYSTEM_SERVER_NAME,
    version: "0.1.0",
    tools: buildSystemTools(store, ctx),
  });
}
