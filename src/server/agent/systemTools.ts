import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { parseRoutineSchedule, type ScheduleError } from "../routineSchedule.js";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig, Plugin, RoutineJob, RoutineSchedulePatch } from "../types.js";
import { text } from "./mcpTools.js";
import { summarizeOwnerState } from "./ownerState.js";

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
  owner: AgentOwner;
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
  config: AppConfig;
  /**
   * The user's per-conversation model tier (alias) for THIS run, if one was chosen
   * in the composer. Reported by describe_system so the avatar names the model it
   * actually runs with. Undefined → no per-conversation pick. Ignored when an env
   * pin is set (the pin wins). See modelTiers.ts / claudeAgent effectiveModel.
   */
  selectedModelTier?: string;
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

/** Agent-facing (English) messages for each schedule validation error. */
const ENGLISH_SCHEDULE_ERROR: Record<ScheduleError, string> = {
  INVALID_KIND: "scheduleKind must be one of: daily, weekly, interval.",
  TIME_REQUIRED: "time (HH:MM, KST) is required for daily and weekly schedules.",
  INVALID_TIME: "time must be in HH:MM format.",
  DAYS_REQUIRED: "weekly schedules require at least one weekday in daysOfWeek.",
  INVALID_DAYS: "daysOfWeek must be integers 0-6 (0=Sunday, 6=Saturday).",
  INTERVAL_REQUIRED: "intervalMinutes is required for interval schedules.",
  INVALID_INTERVAL: "intervalMinutes must be an integer between 15 and 10080.",
};

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A concise English summary of a routine's firing schedule. */
function formatScheduleEnglish(job: RoutineJob): string {
  switch (job.scheduleKind) {
    case "weekly": {
      const days = (job.daysOfWeek ?? []).map((d) => WEEKDAY_NAMES[d] ?? String(d)).join(",");
      return `weekly on ${days} at ${job.time} KST`;
    }
    case "interval": {
      const n = job.intervalMinutes ?? 0;
      return n % 60 === 0 ? `every ${n / 60}h` : `every ${n}m`;
    }
    case "daily":
    default:
      return `daily at ${job.time} KST`;
  }
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
    `name=${job.name ? JSON.stringify(job.name) : "(unnamed)"}`,
    `schedule=${formatScheduleEnglish(job)}`,
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
          "- Routines run headlessly on a daily, weekly, or interval schedule in KST, work with the same tool permissions as the owner, and leave their results in the routines tab.",
          "- Secret values are not exposed; only their names are revealed to the avatar.",
          "- Remote git operations (clone/push, etc.) are performed only through dedicated MCP tools. The shell has no git credentials.",
        ];
        if (!ctx.viewerIsOwner) {
          return text(
            `${publicGuide.join("\n")}\n\nThe current conversation partner is not the owner, so changes to plugin/routine/knowledge-repository settings cannot be made.`,
          );
        }
        // Repo/token/secret/group/git-repo/open-request/model facts come from the
        // shared owner self-state reader (the same source buildPrompt derives from),
        // so describe_system and buildPrompt can't drift in WHAT they read. The
        // describe_system-only facts below (plugins/routines/visibility/intro/
        // hashtags/runtime/maxTurns/Confluence) stay read here, as buildPrompt
        // never surfaces them.
        const state = summarizeOwnerState(store, ctx.config, ctx.avatarUserId);
        const plugins = store.listPlugins(ctx.avatarUserId);
        const routines = store.listRoutineJobs(ctx.avatarUserId);
        const knowledgeRepo = state.knowledgeRepo;
        const secretNames = state.secretNames;
        const groups = state.groups;
        const openRequests = state.openRequestCount;
        // Mirrors the runtime's model resolution (claudeAgent: env pin > user
        // per-conversation tier > admin override > SDK default) so the avatar
        // reports the model it ACTUALLY runs with, not just the env value.
        const adminModel = state.modelOverride;
        const userTier = ctx.selectedModelTier;
        // When a tier is chosen, name the concrete model it maps to if the operator
        // pinned one via ANTHROPIC_DEFAULT_<TIER>_MODEL (else just the alias — the
        // SDK resolves it to the account default the app can't name).
        const tierModel = userTier ? ctx.config.defaultTierModels[userTier] : undefined;
        const modelLine = state.anthropicModel
          ? `${state.anthropicModel} (pinned via environment variable)`
          : userTier
            ? `${tierModel ? `${tierModel} (${userTier})` : userTier} (chosen for this conversation in the composer)`
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
          `- General git repos: ${state.gitRepoCount}`,
          `- Internal Git token (GIT_TOKEN): ${state.gitTokenSet ? "set" : "not set"}`,
          `- Secret names: ${secretNames.length ? secretNames.map((name) => `\`${name}\``).join(", ") : "(none)"}`,
          `- Remote SSH tools: ${secretNames.includes("SSH_PRIVATE_KEY") ? "enabled (SSH_PRIVATE_KEY set)" : "disabled (no SSH_PRIVATE_KEY secret)"}`,
          `- Groups: ${groups.length ? groups.map((g) => `${g.name}(${g.role === "admin" ? "admin" : "member"}, shared repository ${g.knowledgeRepoConfigured ? "connected" : "none"})`).join(", ") : "(none)"} — members of the same group automatically trust each other mutually (this is the ONLY source of elevated access; manage trust by managing group membership).`,
          `- Experimental features: ${state.experimentalFeatures.length ? state.experimentalFeatures.join(", ") + " (beta — behavior may change)" : "(none enabled)"}`,
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
      "Lists the owner's avatar routines. Routines run headlessly on a daily, weekly, or interval schedule in KST and use the same tool permissions as the owner. (owner only)",
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
      "Creates a new routine task. Runs the prompt headlessly on a daily, weekly, or interval schedule in KST, and leaves the result of working with the same tool permissions as the owner in the routines tab. (owner only)",
      {
        prompt: z.string().describe("The task instruction to run on schedule"),
        name: z.string().optional().describe("Short display name for the routine (optional)"),
        scheduleKind: z
          .enum(["daily", "weekly", "interval"])
          .optional()
          .describe("Schedule type; defaults to daily"),
        time: z.string().optional().describe("HH:MM in KST for daily/weekly, e.g.: 09:30"),
        daysOfWeek: z
          .array(z.number())
          .optional()
          .describe("Weekdays for weekly schedules: 0=Sun..6=Sat"),
        intervalMinutes: z
          .number()
          .optional()
          .describe("Interval length in minutes for interval schedules; 15..10080"),
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
        const parsed = parseRoutineSchedule({
          scheduleKind: args.scheduleKind,
          time: args.time,
          daysOfWeek: args.daysOfWeek,
          intervalMinutes: args.intervalMinutes,
        });
        if (!parsed.ok) {
          return text(ENGLISH_SCHEDULE_ERROR[parsed.error], true);
        }
        const routine = store.createRoutineJob(ctx.avatarUserId, {
          name: args.name?.trim() || null,
          prompt,
          scheduleKind: parsed.value.kind,
          minuteOfDay: parsed.value.minuteOfDay,
          daysOfWeek: parsed.value.daysOfWeek,
          intervalMinutes: parsed.value.intervalMinutes,
          enabled: args.enabled,
        });
        store.audit({
          ...actor(ctx),
          action: "system_tool_create_routine",
          status: "success",
          detail: `routine ${routine.id} (${formatScheduleEnglish(routine)})`,
        });
        return text(`Created the routine:\n${renderRoutine(routine)}`);
      },
    ),
    tool(
      "update_routine",
      "Updates an existing routine's name, prompt, schedule (daily/weekly/interval in KST), and enabled values. Provide any of scheduleKind/time/daysOfWeek/intervalMinutes to replace the schedule. (owner only)",
      {
        id: z.string().describe("id of the routine to update"),
        prompt: z.string().optional().describe("New task instruction"),
        name: z.string().optional().describe("New display name; pass an empty string to clear it"),
        scheduleKind: z
          .enum(["daily", "weekly", "interval"])
          .optional()
          .describe("New schedule type"),
        time: z.string().optional().describe("HH:MM in KST for daily/weekly"),
        daysOfWeek: z
          .array(z.number())
          .optional()
          .describe("Weekdays for weekly schedules: 0=Sun..6=Sat"),
        intervalMinutes: z
          .number()
          .optional()
          .describe("Interval length in minutes for interval schedules; 15..10080"),
        enabled: z.boolean().optional().describe("Whether enabled"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const patch: RoutineSchedulePatch & {
          name?: string | null;
          prompt?: string;
          enabled?: boolean;
        } = {};
        if (args.prompt !== undefined) {
          const prompt = args.prompt.trim();
          if (!prompt) {
            return text("Please enter a prompt.", true);
          }
          patch.prompt = prompt;
        }
        if (args.name !== undefined) {
          patch.name = args.name.trim() || null;
        }
        const scheduleProvided =
          args.scheduleKind !== undefined ||
          args.time !== undefined ||
          args.daysOfWeek !== undefined ||
          args.intervalMinutes !== undefined;
        if (scheduleProvided) {
          const parsed = parseRoutineSchedule({
            scheduleKind: args.scheduleKind,
            time: args.time,
            daysOfWeek: args.daysOfWeek,
            intervalMinutes: args.intervalMinutes,
          });
          if (!parsed.ok) {
            return text(ENGLISH_SCHEDULE_ERROR[parsed.error], true);
          }
          patch.scheduleKind = parsed.value.kind;
          patch.minuteOfDay = parsed.value.minuteOfDay;
          patch.daysOfWeek = parsed.value.daysOfWeek;
          patch.intervalMinutes = parsed.value.intervalMinutes;
        }
        if (args.enabled !== undefined) {
          patch.enabled = args.enabled;
        }
        if (Object.keys(patch).length === 0) {
          return text("At least one of the values to update (name, prompt, schedule, enabled) is required.", true);
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
