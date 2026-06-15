export type {
  AdminGroupSummary,
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

export type ViewName = "explore" | "chat" | "inbox" | "routines" | "settings" | "admin";
export type SettingsTab = "profile" | "access" | "knowledge" | "groups";
export type AdminTab = "overview" | "users" | "groups" | "access" | "system" | "audit";
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
  /** Set when tool/agent activity interrupts the text stream; the next delta inserts a paragraph break so resumed text doesn't run onto the previous line. */
  liveTextBreakPending?: boolean;
  /** Plan submitted via ExitPlanMode this turn (plan mode); shown live as a plan card until the turn finishes and the persisted `response.plan` takes over. */
  livePlan?: string;
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
  /** User-chosen model tier (alias) for this conversation; "" / undefined = server default. */
  modelTier?: string;
  /** User-chosen reasoning effort level for this conversation; "" / undefined = SDK default (high). */
  effort?: string;
  /** Visual-canvas artifacts shown in this conversation (experimental, #50). */
  canvases: PaneCanvas[];
  /** Which canvas is currently shown in the side panel (artifact id). */
  activeCanvasId?: string | null;
  /** Active repo workspace (#47): registered repo name the avatar edits natively, or "". */
  activeRepo?: string;
  greetingStarted?: boolean;
  greetedConversationId?: string | null;
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
  /** Controls are shown and awaiting the user's submission. */
  pending?: boolean;
  /** A submit POST is in flight. */
  submitting?: boolean;
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
    tiers: (import("../../../server/modelTiers").ModelTier & { model: string | null })[];
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
}
