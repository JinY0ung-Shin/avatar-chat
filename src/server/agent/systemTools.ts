import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  isFutureOnceSchedule,
  parseRoutineSchedule,
  type RoutineSchedule,
  type ScheduleError,
} from "../routineSchedule.js";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig, Plugin, RoutineJob, RoutineSchedulePatch } from "../types.js";
import { text } from "./mcpTools.js";
import { DEFAULT_MODEL_TIER } from "../modelTiers.js";
import { EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL } from "../effortLevels.js";
import { summarizeGroupAgentState, summarizeOwnerState } from "./ownerState.js";
import { MCP_TOOL_GROUPS, type McpToolGroupId } from "../../shared/mcpToolGroups.js";
import type { ToolSkillPolicy } from "../toolSkillPolicy.js";
import { webFetchProxyState } from "./webFetchTools.js";

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
  /**
   * The user's per-conversation reasoning effort level for THIS run, if one was
   * chosen in the composer. Reported by describe_system alongside the model so the
   * avatar knows how much thinking it applies this turn. Undefined → no pick (the
   * SDK applies its `high` default). Independent of the model pin. See
   * effortLevels.ts / claudeAgent userEffort.
   */
  selectedEffort?: string;
  /**
   * MCP tool groups enabled for THIS run, chosen in the chat composer. Arrives
   * already clamped by the admin's per-group tool policy — describe_system
   * reports WHAT is enabled and deliberately never which groups a policy
   * blocked (the avatar only knows the tools it has).
   */
  enabledMcpToolGroups?: McpToolGroupId[];
  /**
   * Admin-managed built-in tool/skill on-off policy for this deployment.
   * Reported by describe_system (META-COGNITION), mirroring buildPrompt's
   * admin-disabled standing note. Undefined → treated as nothing disabled.
   */
  toolSkillPolicy?: ToolSkillPolicy;
  /**
   * The working repository (by NAME) opened for THIS conversation via
   * `mcp__git_repo__open_repo`, if any. Reported by describe_system, mirroring
   * buildPrompt's activeRepoSection. Undefined → no repo open. The server-side
   * clone path is NEVER carried here — only the repo name. See repoWorkspace.ts /
   * claudeAgent request.activeRepoName.
   */
  activeRepoName?: string;
  /** Whether this interactive run can publish local raster images to the chat. */
  fileOutputEnabled?: boolean;
  /**
   * Whether the deployment image carries the PPTX deck toolchain (LibreOffice +
   * pdftoppm + python-pptx). Deployment-wide fact (boot probe), reported by
   * describe_system so the avatar answers "can you make me a PPT?" correctly.
   */
  deckRenderingAvailable?: boolean;
  /**
   * Whether the model THIS run resolved to accepts image input (admin per-tier
   * policy ∘ MODEL_VISION default — see modelVisionPolicy.ts). Undefined →
   * treated as supported.
   */
  visionEnabled?: boolean;
  /**
   * Set ONLY for GROUP SHARED-AGENT runs: describe_system then reports the
   * group's self-state (summarizeGroupAgentState — the same facts the prompt
   * branch gets) instead of an owner block. Management tools keep refusing via
   * viewerIsOwner (false on these runs).
   */
  groupAgent?: { agentId: string; actingUserId: string };
}

/** MCP server name; tools surface to the model as `mcp__system__<tool>`. */
export const SYSTEM_SERVER_NAME = "system";

/** Tool names the model may call, in `allowedTools` form. */
export const SYSTEM_TOOL_NAMES = [
  "mcp__system__describe_system",
  "mcp__system__notify_user",
  "mcp__system__list_recent_conversations",
  "mcp__system__read_conversation",
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
  INVALID_KIND: "scheduleKind must be one of: once, daily, weekly, interval.",
  TIME_REQUIRED: "time (HH:MM, KST) is required for once, daily, and weekly schedules.",
  INVALID_TIME: "time must be in HH:MM format.",
  DAYS_REQUIRED: "weekly schedules require at least one weekday in daysOfWeek.",
  INVALID_DAYS: "daysOfWeek must be integers 0-6 (0=Sunday, 6=Saturday).",
  INTERVAL_REQUIRED: "intervalMinutes is required for interval schedules.",
  INVALID_INTERVAL: "intervalMinutes must be an integer between 5 and 10080.",
  DATE_REQUIRED: "date (YYYY-MM-DD, KST) is required for one-time schedules.",
  INVALID_DATE: "date must be a real calendar date in YYYY-MM-DD format.",
  DATE_IN_PAST: "A one-time schedule must be later than the current KST date and time.",
};

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A concise English summary of a routine's firing schedule. */
function formatScheduleEnglish(job: RoutineJob): string {
  switch (job.scheduleKind) {
    case "once":
      return `once on ${job.runDate ?? "(missing date)"} at ${job.time} KST`;
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
          // The wall-clock budget is stated here because it is ACTIONABLE at
          // routine-creation time: over it the run is aborted mid-task and only its
          // partial output survives, so the avatar should size a routine's prompt to
          // fit rather than discover the ceiling by being killed.
          `- Routines run headlessly once at a specified KST date/time or recur on a daily, weekly, or interval schedule, work with the same tool permissions as the owner, and leave their results in the routines tab. A routine can also open one registered git repository as its working directory (open_repo) — the selection persists and takes effect from the routine's next scheduled run. Each run has a hard wall-clock limit of ${Math.round(ctx.config.routineRunTimeoutMs / 60_000)} minutes covering the ENTIRE run; when it is hit the run is aborted and only the text produced so far is kept. Scope a routine to fit that budget, and split work that cannot into several routines.`,
          "- Secret values are not exposed; only their names are revealed to the avatar.",
          "- Remote git operations (clone/push, etc.) are performed only through dedicated MCP tools. The shell has no git credentials.",
        ];
        // GROUP SHARED-AGENT runs: report the GROUP's self-state (the same
        // facts the group-agent prompt branch carries — GroupAgentState) and
        // stop; there is no owner block to build.
        if (ctx.groupAgent) {
          const ga = summarizeGroupAgentState(
            store,
            ctx.config,
            ctx.groupAgent.agentId,
            ctx.groupAgent.actingUserId,
          );
          if (!ga) {
            return text(
              `${publicGuide.join("\n")}\n\nThis shared group agent's group no longer exists, so no state can be reported.`,
            );
          }
          // Model/effort/tool-group lines mirror the owner block below (small
          // deliberate duplication — the owner strings are test-pinned).
          const gaTier = ctx.selectedModelTier;
          const gaTierModel = gaTier ? ctx.config.defaultTierModels[gaTier] : undefined;
          const gaDefaultModel = ctx.config.defaultTierModels[DEFAULT_MODEL_TIER];
          const gaModelLine = ga.anthropicModel
            ? `${ga.anthropicModel} (pinned via environment variable)`
            : gaTier
              ? `${gaTierModel ? `${gaTierModel} (${gaTier})` : gaTier} (chosen for this conversation in the composer)`
              : ga.modelOverride
                ? `${ga.modelOverride} (admin setting)`
                : `${gaDefaultModel ? `${gaDefaultModel} (${DEFAULT_MODEL_TIER})` : DEFAULT_MODEL_TIER} (default)`;
          const gaEffort = ctx.selectedEffort;
          const gaEffortLabel = (id: string) => EFFORT_LEVELS.find((e) => e.id === id)?.label;
          const gaEffortLine = gaEffort
            ? `${gaEffortLabel(gaEffort) ? `${gaEffort} (${gaEffortLabel(gaEffort)})` : gaEffort} (chosen for this conversation)`
            : `${gaEffortLabel(DEFAULT_EFFORT_LEVEL) ? `${DEFAULT_EFFORT_LEVEL} (${gaEffortLabel(DEFAULT_EFFORT_LEVEL)})` : DEFAULT_EFFORT_LEVEL} (default)`;
          const gaEnabled = ctx.enabledMcpToolGroups ?? MCP_TOOL_GROUPS.map((group) => group.id);
          const gaLabels = MCP_TOOL_GROUPS
            .filter((group) => gaEnabled.includes(group.id))
            .map((group) => group.labelEn);
          return text(
            [
              ...publicGuide,
              "",
              "Current GROUP SHARED-AGENT state:",
              `- Kind: shared agent '${ga.displayName}' of the group '${ga.groupName}' (a team resource, not a personal avatar; the group may have other shared agents)`,
              `- Enabled: ${ga.enabled ? "yes" : "no — disabled by a group admin"}`,
              `- Capture policy: ${ga.captureScope === "members" ? "all group members may capture" : "group admins only"}; the member in this conversation (role: ${ga.viewerRole ?? "removed — no longer a group member"}) ${ga.captureAllowed ? "MAY capture (write + commit)" : "may NOT capture (recall/read only)"}`,
              `- Team second brain (shared knowledge repository): ${ga.knowledgeRepoConfigured ? `${ga.knowledgeRepo.repo}${ga.knowledgeRepo.branch ? ` @ ${ga.knowledgeRepo.branch}` : ""}` : "(none — ask a group admin to connect one in group settings)"}`,
              `- This member's internal Git token (GIT_TOKEN): ${ga.viewerGitTokenSet ? "set" : "not set — capture's commit/push will fail until they register one in Settings"}`,
              `- Model in use: ${gaModelLine}`,
              `- Reasoning effort: ${gaEffortLine}`,
              `- MCP tool groups enabled for this conversation: ${gaLabels.length ? gaLabels.join(", ") : "(none)"}`,
              "- Capability boundary: NO personal knowledge repository/brain, secrets, SSH, routines, notifications, personal git repositories, or plugins beyond the group repository.",
              "- Group admins manage this agent in the 그룹 (Groups) view on the left rail.",
            ].join("\n"),
          );
        }
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
        // No env pin, no tier, no admin override → the default tier (opus).
        const defaultModel = ctx.config.defaultTierModels[DEFAULT_MODEL_TIER];
        const modelLine = state.anthropicModel
          ? `${state.anthropicModel} (pinned via environment variable)`
          : userTier
            ? `${tierModel ? `${tierModel} (${userTier})` : userTier} (chosen for this conversation in the composer)`
            : adminModel
              ? `${adminModel} (admin setting)`
              : `${defaultModel ? `${defaultModel} (${DEFAULT_MODEL_TIER})` : DEFAULT_MODEL_TIER} (default)`;
        // Per-conversation reasoning effort, mirroring the model-tier wiring above:
        // when the composer picked a level, name it (with its Korean label) as the
        // effort chosen for THIS conversation; otherwise the SDK's `high` default.
        // The SDK may silently downgrade an unsupported level for the active model.
        const userEffort = ctx.selectedEffort;
        const effortLabel = (id: string) => EFFORT_LEVELS.find((e) => e.id === id)?.label;
        const effortLine = userEffort
          ? `${effortLabel(userEffort) ? `${userEffort} (${effortLabel(userEffort)})` : userEffort} (chosen for this conversation)`
          : `${effortLabel(DEFAULT_EFFORT_LEVEL) ? `${DEFAULT_EFFORT_LEVEL} (${effortLabel(DEFAULT_EFFORT_LEVEL)})` : DEFAULT_EFFORT_LEVEL} (default)`;
        const enabledMcpToolGroups = ctx.enabledMcpToolGroups ?? MCP_TOOL_GROUPS.map((group) => group.id);
        const webProxy = webFetchProxyState();
        const enabledMcpToolGroupLabels = MCP_TOOL_GROUPS
          .filter((group) => enabledMcpToolGroups.includes(group.id))
          .map((group) => group.labelEn);
        const hashtags = user?.hashtags ?? [];
        const visibilityLabel =
          user?.visibility === "private"
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
          `- Reasoning effort: ${effortLine}`,
          `- MCP tool groups enabled for this conversation: ${enabledMcpToolGroupLabels.length ? enabledMcpToolGroupLabels.join(", ") : "(none)"}`,
          `- maxTurns: ${ctx.config.maxTurns}`,
          `- Autocompact window: ${ctx.config.autoCompactWindow ? `${ctx.config.autoCompactWindow} tokens (AUTO_COMPACT_WINDOW)` : "model default (full context window)"}`,
          `- Confluence host: ${ctx.config.confluenceUrl ? "set" : "(none)"}`,
          `- Confluence PAT: ${secretNames.includes("CONFLUENCE_PAT") || secretNames.includes("CONFLUENCE_PERSONAL_ACCESS_TOKEN") ? "secret set" : "(none)"}`,
          // Mirrors buildSystemPromptAppend's web-fetch proxy self-state (the
          // shared webFetchProxyState helper; values already redacted).
          `- Web fetch (mcp__web__fetch): ${enabledMcpToolGroups.includes("web") ? "enabled for this conversation" : "OFF for this conversation (web tool group deselected)"}; ${webProxy.httpsProxy || webProxy.httpProxy ? `external URLs go through the corporate proxy (${webProxy.httpsProxy ?? webProxy.httpProxy}${webProxy.noProxy ? `; NO_PROXY: ${webProxy.noProxy}` : ""})` : "no HTTP_PROXY/HTTPS_PROXY configured — intranet URLs direct; external sites may be unreachable if this deployment requires a proxy"}`,
          `- Admin-disabled built-in tools: ${ctx.toolSkillPolicy?.disabledTools.length ? ctx.toolSkillPolicy.disabledTools.map((name) => `\`${name}\``).join(", ") + " (removed deployment-wide by the system administrator)" : "(none)"}`,
          `- Admin-disabled skills: ${ctx.toolSkillPolicy?.disabledSkills.length ? ctx.toolSkillPolicy.disabledSkills.map((name) => `\`${name}\``).join(", ") + " (deployment-wide; they may still appear in a skill listing but every invocation is blocked)" : "(none)"}`,
          `- Knowledge repository: ${knowledgeRepo.repo || "(none)"}${knowledgeRepo.branch ? ` @ ${knowledgeRepo.branch}` : ""}`,
          `- Shared (communal) account: ${state.sharedAccount ? "yes — trusted same-group teammates chatting with this avatar can also update the personal knowledge repository (write/commit); repo creation/connection stays owner-only" : "no — knowledge-repo writes are owner-only (toggle under Settings → Profile)"}`,
          `- Second brain (personal): ${state.knowledgeRepoConfigured ? "active — `mcp__brain__search` recall over wiki/, plus the brain-search/brain-ingest/brain-reflect/brain-lint skills (run brain-migrate once if the wiki/ vault is missing)" : "inactive (connect a knowledge repository to enable brain recall/ingest/reflect)"}`,
          `- Team second brain: ${groups.filter((g) => g.knowledgeRepoConfigured).length > 0 ? `${groups.filter((g) => g.knowledgeRepoConfigured).length} group(s) expose \`mcp__group_brain__search\` (members search; admins consolidate)` : "none (no group has a connected shared repository)"}`,
          `- General git repos: ${state.gitRepoCount}`,
          `- Working repository: ${ctx.activeRepoName ? `${ctx.activeRepoName} (opened via open_repo; local edits/commit native, push via mcp__git_repo__push)` : "(none open)"}`,
          `- Local image output: ${ctx.fileOutputEnabled ? "enabled — use `mcp__file_output__show_file` for PNG/JPEG/WebP/GIF files in the working directories" : "unavailable in this run"}`,
          `- Image input (vision): ${ctx.visionEnabled === false ? "NOT supported by the currently selected model — Read on image/PDF files is blocked and chat image uploads are disabled; show images to the USER via mcp__file_output__show_file, extract PDF text via `pdftotext` (a different model tier may support images — the admin panel sets this per tier)" : "supported by the currently selected model"}`,
          `- Document deck generation (PPTX): ${ctx.deckRenderingAvailable ? `toolchain available (python-pptx + LibreOffice + pdftoppm)${ctx.fileOutputEnabled ? " — use the `pptx` skill: generate, render slide previews, then `mcp__file_output__share_file` for the download" : "; preview/download need an interactive chat turn"}` : "UNAVAILABLE — this deployment image lacks the LibreOffice/python-pptx toolchain; tell the user a system administrator must rebuild the server image to enable PPT generation (do not attempt shell workarounds)"}`,
          `- Internal Git token (GIT_TOKEN): ${state.gitTokenSet ? "set" : "not set"}`,
          `- Secret names: ${secretNames.length ? secretNames.map((name) => `\`${name}\``).join(", ") + " (custom secrets are injected as env into MCP servers from your own plugins/knowledge repo; git/SSH credentials go only to their dedicated tools)" : "(none)"}`,
          `- Shell-exposed secrets: ${state.shellExposedSecretNames.length ? state.shellExposedSecretNames.map((name) => `\`${name}\``).join(", ") + " — usable as `$NAME` in Bash on elevated runs; values are redacted from tool outputs (per-secret 셸 노출 toggle in Settings)" : "(none — every secret stays out of the agent shell; enable per-secret with the 셸 노출 toggle in Settings)"}`,
          `- Remote SSH tools: ${secretNames.includes("SSH_PRIVATE_KEY") ? "enabled (SSH_PRIVATE_KEY set)" : "disabled (no SSH_PRIVATE_KEY secret)"}`,
          `- Groups: ${groups.length ? groups.map((g) => `${g.name}(${g.role === "admin" ? "admin" : "member"}, shared repository ${g.knowledgeRepoConfigured ? "connected" : "none"}${g.avatarSharing ? "" : ", avatar sharing off"})`).join(", ") : "(none)"} — members of the same group automatically trust each other mutually (this is the ONLY source of elevated access; manage trust by managing group membership).${groups.some((g) => !g.avatarSharing) ? ' Groups marked "avatar sharing off" are knowledge-sharing-only: their co-membership grants neither avatar visibility nor mutual trust.' : ""}`,
          `- Avatar consultation (mcp__avatars__ask_avatar): ${enabledMcpToolGroups.includes("avatars") ? (groups.some((g) => g.avatarSharing) ? "available — you can ask a same-group teammate's avatar one question on the owner's behalf; it answers from its persona + personal-knowledge recall. Attribute answers to that avatar and capture durable learnings with brain-ingest." : groups.length > 0 ? "enabled, but none of the owner's groups share avatars (avatar sharing off), so no teammate avatar is reachable" : "enabled, but the owner belongs to no groups, so no teammate avatar is reachable (consultation requires shared group membership)") : "OFF for this conversation (avatars tool group deselected)"}`,
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
      "list_recent_conversations",
      "Lists the avatar owner's recent conversations so a routine (or the owner) can review what happened — e.g. the nightly second-brain consolidation reviewing the last day. Returns id, title, the other avatar's name, and last-updated time — NOT the full transcript (use read_conversation for that). `sinceHours` bounds the window (default 24). By default only normal chat conversations are returned (routine logs are excluded); pass `kind: 'all'` to include them. Read-only and scoped to the owner — you can never see other users' conversations. (owner / owner routine only)",
      {
        sinceHours: z.number().int().optional().describe("Only conversations updated within the last N hours (default 24)."),
        kind: z.enum(["chat", "routine", "all"]).optional().describe("Which conversations to include (default 'chat')."),
        limit: z.number().int().optional().describe("Max conversations to return (default 50, max 200)."),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const kind = args.kind ?? "chat";
        const sinceHours = Math.max(1, args.sinceHours ?? 24);
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        const cutoffMs = Date.now() - sinceHours * 3_600_000;
        const recent = store
          .listConversations(ctx.avatarUserId, undefined, kind)
          .filter((c) => {
            const t = Date.parse(c.updatedAt);
            return Number.isNaN(t) || t >= cutoffMs;
          })
          .slice(0, limit);
        if (recent.length === 0) {
          return text(`No conversations updated in the last ${sinceHours}h (kind=${kind}).`);
        }
        const body = recent
          .map(
            (c) =>
              `- ${c.id} | ${c.title} | with ${c.avatarDisplayName} | ${c.updatedAt}${c.isRoutine ? " [routine]" : ""}`,
          )
          .join("\n");
        return text(
          `Recent conversations (last ${sinceHours}h, kind=${kind}, ${recent.length} shown):\n${body}\n\nRead one with read_conversation.`,
        );
      },
    ),
    tool(
      "read_conversation",
      "Reads the message transcript of one of the owner's conversations by id (get ids from list_recent_conversations). Returns the ordered user/assistant messages as plain text; tool activity, attachments, and model metadata are omitted, and long messages are truncated to keep the transcript compact. Only the owner's own conversations are accessible — an unknown or foreign id returns nothing. Process conversations one at a time and commit between batches so the transcript does not accumulate. (owner / owner routine only)",
      {
        conversationId: z.string().describe("The conversation id (from list_recent_conversations)."),
        maxChars: z.number().int().optional().describe("Per-message truncation length (default 4000, max 8000)."),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        // listMessages is owner-gated: it returns [] for any conversation the
        // owner does not own, so a guessed/foreign id can never leak another
        // user's transcript. ctx.avatarUserId is the bound owner — never an arg.
        const messages = store.listMessages(ctx.avatarUserId, args.conversationId);
        if (messages.length === 0) {
          return text("Conversation not found, or it is not yours.", true);
        }
        const perMsg = Math.min(Math.max(200, args.maxChars ?? 4000), 8000);
        const GLOBAL_CAP = 60_000;
        const out: string[] = [];
        let total = 0;
        for (const m of messages) {
          if (m.role === "system") continue;
          let content = m.content ?? "";
          if (content.length > perMsg) content = `${content.slice(0, perMsg)}…`;
          const line = `[${m.role}] ${content}`;
          if (total + line.length > GLOBAL_CAP) {
            out.push("…(transcript truncated)");
            break;
          }
          out.push(line);
          total += line.length;
        }
        return text(out.join("\n\n") || "(no readable messages)");
      },
    ),
    tool(
      "list_routines",
      "Lists the owner's avatar routines. Routines run headlessly once at a specified KST date/time or recur daily, weekly, or at an interval, using the same tool permissions as the owner. (owner only)",
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
      "Creates a new routine task. Runs the prompt headlessly once at a specified KST date/time or on a recurring daily, weekly, or interval schedule, and leaves the result in the routines tab. (owner only)",
      {
        prompt: z.string().describe("The task instruction to run on schedule"),
        name: z.string().optional().describe("Short display name for the routine (optional)"),
        scheduleKind: z
          .enum(["once", "daily", "weekly", "interval"])
          .optional()
          .describe("Schedule type; defaults to daily"),
        date: z.string().optional().describe("YYYY-MM-DD in KST for one-time schedules"),
        time: z.string().optional().describe("HH:MM in KST for once/daily/weekly, e.g.: 09:30"),
        daysOfWeek: z
          .array(z.number())
          .optional()
          .describe("Weekdays for weekly schedules: 0=Sun..6=Sat"),
        intervalMinutes: z
          .number()
          .optional()
          .describe("Interval length in minutes for interval schedules; 5..10080"),
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
          date: args.date,
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
          runDate: parsed.value.runDate,
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
      "Updates an existing routine's name, prompt, schedule (once/daily/weekly/interval in KST), and enabled values. Provide any of scheduleKind/date/time/daysOfWeek/intervalMinutes to replace the schedule. (owner only)",
      {
        id: z.string().describe("id of the routine to update"),
        prompt: z.string().optional().describe("New task instruction"),
        name: z.string().optional().describe("New display name; pass an empty string to clear it"),
        scheduleKind: z
          .enum(["once", "daily", "weekly", "interval"])
          .optional()
          .describe("New schedule type"),
        date: z.string().optional().describe("YYYY-MM-DD in KST for one-time schedules"),
        time: z.string().optional().describe("HH:MM in KST for once/daily/weekly"),
        daysOfWeek: z
          .array(z.number())
          .optional()
          .describe("Weekdays for weekly schedules: 0=Sun..6=Sat"),
        intervalMinutes: z
          .number()
          .optional()
          .describe("Interval length in minutes for interval schedules; 5..10080"),
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
          args.date !== undefined ||
          args.time !== undefined ||
          args.daysOfWeek !== undefined ||
          args.intervalMinutes !== undefined;
        if (scheduleProvided) {
          const parsed = parseRoutineSchedule({
            scheduleKind: args.scheduleKind,
            time: args.time,
            daysOfWeek: args.daysOfWeek,
            intervalMinutes: args.intervalMinutes,
            date: args.date,
          });
          if (!parsed.ok) {
            return text(ENGLISH_SCHEDULE_ERROR[parsed.error], true);
          }
          patch.scheduleKind = parsed.value.kind;
          patch.minuteOfDay = parsed.value.minuteOfDay;
          patch.daysOfWeek = parsed.value.daysOfWeek;
          patch.intervalMinutes = parsed.value.intervalMinutes;
          patch.runDate = parsed.value.runDate;
        }
        if (args.enabled !== undefined) {
          patch.enabled = args.enabled;
        }
        if (Object.keys(patch).length === 0) {
          return text("At least one of the values to update (name, prompt, schedule, enabled) is required.", true);
        }
        const current = store.getRoutineJob(ctx.avatarUserId, args.id);
        if (!current) {
          return text("Routine not found.", true);
        }
        if (patch.enabled === true) {
          const candidate: RoutineSchedule = {
            kind: patch.scheduleKind ?? current.scheduleKind,
            minuteOfDay: patch.minuteOfDay ?? current.minuteOfDay,
            daysOfWeek:
              patch.daysOfWeek !== undefined ? patch.daysOfWeek : current.daysOfWeek,
            intervalMinutes:
              patch.intervalMinutes !== undefined
                ? patch.intervalMinutes
                : current.intervalMinutes,
            runDate: patch.runDate !== undefined ? patch.runDate : current.runDate,
          };
          if (!isFutureOnceSchedule(candidate)) {
            return text(ENGLISH_SCHEDULE_ERROR.DATE_IN_PAST, true);
          }
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
