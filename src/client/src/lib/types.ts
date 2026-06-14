export type {
  AdminGroupSummary,
  AdminStats,
  AdminUserDetail,
  AdminUserSummary,
  AgentResponse,
  AuditEvent,
  AvatarDetail,
  AvatarNotification,
  AvatarSummary,
  AvatarVisibility,
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
  liveEvents: LiveActivity[];
  groupKnowledgeOff: string[];
  greetingStarted?: boolean;
  abortController?: AbortController | null;
}

export interface LiveActivity {
  id: string;
  kind:
    | "status"
    | "plugin"
    | "agent"
    | "tool"
    | "task"
    | "blocked"
    | "permission"
    | "question"
    | "error";
  label: string;
  detail?: string;
  status?: string;
  runId?: string;
  requestId?: string;
  payload?: unknown;
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
