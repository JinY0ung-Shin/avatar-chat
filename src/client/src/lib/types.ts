export type {
  AdminGroupSummary,
  AdminExternalAgent,
  AdminExternalAgentInput,
  AdminStats,
  AdminUserDetail,
  AdminUserSummary,
  AgentActivity,
  AgentResponse,
  AgentUsage,
  AuditEvent,
  AvatarDetail,
  AvatarNotification,
  AvatarSummary,
  AvatarVisibility,
  CanvasArtifact,
  CanvasContentType,
  CanvasControl,
  ConversationSummary,
  Group,
  GroupMember,
  ImageMediaType,
  KnowledgeGraph,
  KnowledgeGraphNode,
  KnowledgeNote,
  KnowledgeRepoStatus,
  KnowledgeRequest,
  MessageAttachment,
  Plugin,
  RepoPluginContents,
  RoutineJob,
  SignupMode,
  SkillInfo,
  StoredMessage,
  User,
} from "../../../server/types.js";

import type { CanvasArtifact } from "../../../server/types.js";
import type { McpToolGroupId } from "../../../shared/mcpToolGroups";

export type ViewName =
  | "explore"
  | "chat"
  | "brain"
  | "inbox"
  | "routines"
  | "settings"
  | "admin";
export type SettingsTab = "profile" | "access" | "knowledge" | "groups";
export type AdminTab =
  | "overview"
  | "users"
  | "groups"
  | "external-agents"
  | "access"
  | "system"
  | "audit";
export type ChatLayout = "vertical" | "horizontal" | "grid";

/** An image staged in the composer before sending. */
export interface PendingImage {
  /** Client-generated id; reused as the server-side attachment id + filename stem. */
  id: string;
  /** Resized image as a base64 data URL — used for preview AND upload. */
  dataUrl: string;
  /** Original filename for alt text / display. */
  name: string;
  mediaType: import("../../../server/types.js").ImageMediaType;
}

export interface ChatPane {
  id: string;
  avatar: import("../../../server/types.js").AvatarDetail;
  conversationId: string;
  messages: import("../../../server/types.js").StoredMessage[];
  draft: string;
  streaming: boolean;
  liveText: string;
  /** Images published by show_file during the currently streaming assistant turn. */
  liveAttachments: import("../../../server/types.js").MessageAttachment[];
  /** Set when tool/agent activity interrupts the text stream; the next delta inserts a paragraph break so resumed text doesn't run onto the previous line. */
  liveTextBreakPending?: boolean;
  /** The model's reasoning (extended-thinking) text streamed this turn; shown in a collapsible "생각 과정" view until the turn finishes and the persisted `response.thinking` takes over. */
  liveThinking?: string;
  /** True while reasoning deltas are actively streaming (set on each thinking delta, cleared once answer text / tool / agent / task / plan activity arrives). Drives the live "생각 중…" indicator on the collapsed thinking card. */
  thinkingActive?: boolean;
  /** Plan submitted via ExitPlanMode this turn (plan mode); shown live as a plan card until the turn finishes and the persisted `response.plan` takes over. */
  livePlan?: string;
  /** True between EnterPlanMode and ExitPlanMode: the avatar is composing a plan in the background. Drives a "writing plan…" placeholder card so the turn doesn't look stalled. Cleared once `livePlan` arrives. */
  planPending?: boolean;
  /** Set when the avatar proposed a plan (ExitPlanMode) and is awaiting the owner's approval; drives inline approve/reject controls on the live plan card. Holds the ids needed to answer via /api/chat/respond. Cleared once answered/resolved. */
  planReview?: { requestId: string; runId: string } | null;
  /** A plan-approval submit (approve/reject) is in flight, to disable the controls. */
  planReviewSubmitting?: boolean;
  liveStatus: string;
  liveRunId: string | null;
  /** Multi-agent activity tree (root "main" + sub-agents) for the live bubble. */
  liveAgents: LiveAgentNode[];
  /** Tool / blocked rows, each owned by an agent in liveAgents. */
  liveTools: LiveToolRow[];
  /** SDK task rows, tracked separately from normal tool calls. */
  liveTasks: LiveTaskRow[];
  /** Plugin-load chips (name + status). */
  livePlugins: LivePluginChip[];
  /** ms timestamp until which a sticky status label resists a generic overwrite. */
  liveStatusStickyUntil?: number;
  groupKnowledgeOff: string[];
  /** Installed skills for this pane's avatar, lazily fetched the first time the slash menu opens (#slash-skills). Drives skill entries in the "/" menu. */
  skills?: import("../../../server/types.js").SkillInfo[];
  /** Guards the one-shot skills fetch (set once the request settles, success or fail). */
  skillsLoaded?: boolean;
  /** Images staged in the composer, not yet sent (data URLs for preview + upload). */
  pendingImages?: PendingImage[];
  /**
   * Locally-held image data URLs keyed by attachment id, so a just-sent user
   * message renders its images instantly (before the bytes are fetchable from
   * the server). On reload this is empty and the bubble falls back to the
   * serving URL (`/api/conversations/:id/images/:imageId`).
   */
  localImages?: Record<string, string>;
  /** User-chosen model for this conversation; "" / undefined = server default. Native panes hold a model TIER alias; external panes hold a GATEWAY model id. */
  modelTier?: string;
  /** Gateway model catalog for an EXTERNAL avatar's picker, lazily fetched when the composer settings first open. undefined = not fetched yet, null = fetch failed (default-only picker). */
  externalModels?: string[] | null;
  /** Admin-configured default gateway model id for an EXTERNAL avatar (null = gateway decides), from the same catalog fetch. */
  externalDefaultModel?: string | null;
  /** User-chosen reasoning effort level for this conversation; "" / undefined = SDK default (high). */
  effort?: string;
  /** MCP tool groups enabled for this conversation; defaults to every group. */
  mcpToolGroups?: McpToolGroupId[];
  /** Visual-canvas artifacts shown in this conversation (experimental, #50). */
  canvases: PaneCanvas[];
  /** Which canvas is currently shown in the side panel (artifact id). */
  activeCanvasId?: string | null;
  /** Whether the viewer is pinned to the transcript bottom (intent-based follow). */
  stickBottom?: boolean;
  /** Last assistant turn's token usage, for the composer badge. */
  usage?: import("../../../server/types.js").AgentUsage | null;
  abortController?: AbortController | null;
}

/**
 * A canvas artifact tracked in a pane. Extends the persisted shape with the live
 * fields needed to submit its controls back through /api/chat/respond. Rebuilt
 * from `message.response.canvases` on reload (then `pending` is false / no ids).
 */
export interface PaneCanvas extends CanvasArtifact {
  /** Run + request ids for submitting declared controls (live turns only). */
  runId?: string;
  requestId?: string;
  /** Controls are shown and awaiting the user's submission (blocking canvases only). */
  pending?: boolean;
  /** A submit POST is in flight. */
  submitting?: boolean;
  /** In-panel editor buffer for an `editable` canvas (not persisted; UI-local). */
  editDraft?: string;
}

/** One agent in the live activity tree; "main" is the root, others nest under parentId. */
export interface LiveAgentNode {
  id: string;
  parentId: string;
  label: string;
  status: "running" | "done" | "failed";
  isMain: boolean;
}

/** A tool/blocked row in the activity tree, owned by an agent. */
export interface LiveToolRow {
  id: string;
  agentId: string;
  kind: "tool" | "task" | "blocked";
  label: string;
  detail?: string;
  status: "running" | "done" | "failed" | "blocked";
}

/** A non-subagent SDK task row in the activity tree. */
export interface LiveTaskRow {
  id: string;
  agentId: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "failed";
}

export interface LivePluginChip {
  name: string;
  status: string;
}

/** An interactive prompt (permission / AskUserQuestion) awaiting the owner. */
export interface PromptRequest {
  id: string;
  runId: string;
  paneId: string;
  kind: "permission" | "question";
  data: any;
}

export interface BootstrapInfo {
  needsSetup: boolean;
  githubHost: string;
  signupMode: "open" | "closed" | "approval";
  confluenceConfigured: boolean;
  /**
   * Per-conversation model picker config: selectable tiers + whether an env-pinned
   * ANTHROPIC_MODEL locks the choice (then the composer hides the picker). Optional
   * for forward-compat with an older server that omits it.
   */
  modelSelection?: {
    /** Each tier + the concrete model id it resolves to (null when not env-pinned). */
    tiers: (import("../../../server/modelTiers").ModelTier & {
      model: string | null;
    })[];
    locked: boolean;
  };
  /**
   * Per-conversation reasoning effort picker config: selectable levels + the
   * default level applied when unset. Independent of the model pin (no lock).
   * Optional for forward-compat with an older server that omits it.
   */
  effortSelection?: {
    levels: import("../../../server/effortLevels").EffortLevel[];
    default: string;
  };
}

export interface Toast {
  id: string;
  message: string;
  kind: "ok" | "info" | "warn";
  actionLabel?: string;
  action?: () => void;
  durationMs?: number;
}
