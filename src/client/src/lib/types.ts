export type {
  AdminGroupSummary,
  AdminStats,
  AdminUserDetail,
  AdminUserSummary,
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
  KnowledgeRepoStatus,
  KnowledgeRequest,
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

export interface ChatPane {
  id: string;
  avatar: import("../../../server/types.js").AvatarDetail;
  conversationId: string;
  messages: import("../../../server/types.js").StoredMessage[];
  draft: string;
  streaming: boolean;
  liveText: string;
  liveStatus: string;
  liveRunId: string | null;
  /** Multi-agent activity tree (root "main" + sub-agents) for the live bubble. */
  liveAgents: LiveAgentNode[];
  /** Tool / task / blocked rows, each owned by an agent in liveAgents. */
  liveTools: LiveToolRow[];
  /** Plugin-load chips (name + status). */
  livePlugins: LivePluginChip[];
  /** ms timestamp until which a sticky status label resists a generic overwrite. */
  liveStatusStickyUntil?: number;
  groupKnowledgeOff: string[];
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

/** A tool/task/blocked row in the activity tree, owned by an agent. */
export interface LiveToolRow {
  id: string;
  agentId: string;
  kind: "tool" | "task" | "blocked";
  label: string;
  detail?: string;
  status: "running" | "done" | "failed" | "blocked";
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
}

export interface Toast {
  id: string;
  message: string;
  kind: "ok" | "info" | "warn";
  actionLabel?: string;
  action?: () => void;
}
