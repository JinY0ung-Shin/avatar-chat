export type AgentRuntime = "claude" | "local";

export interface AppConfig {
  port: number;
  dataDir: string;
  dbPath: string;
  sessionSecret: string;
  agentRuntime: AgentRuntime;
  anthropicApiKey?: string;
  readOnlyTools: string[];
  githubToken?: string;
}

/** Public user shape returned to clients. NEVER includes password_hash. */
export interface User {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  persona: string;
  hasImage: boolean;
  published: boolean;
  roles: string[];
  pluginCount: number;
}

export interface Plugin {
  id: string;
  repo: string;
  ref: string | null;
  label: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface AvatarSummary {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  hasImage: boolean;
  pluginCount: number;
  published: boolean;
  updatedAt: string | null;
}

export interface AvatarDetail extends AvatarSummary {
  persona: string;
  isOwn: boolean;
  plugins: { repo: string; label: string | null }[];
}

export interface ConversationSummary {
  id: string;
  avatarUserId: string;
  avatarDisplayName: string;
  title: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  response: AgentResponse | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  status: string;
  detail: string;
  createdAt: string;
}

export interface AdminUserSummary {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  published: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface AgentResponse {
  kind: "text";
  runtime: "local" | "claude";
  summary: string;
  text: string;
  raw?: unknown;
}

export interface AgentAvatar {
  id: string;
  displayName: string;
  persona: string;
}

export interface AgentRequest {
  message: string;
  avatar: AgentAvatar;
}

export interface PluginRoot {
  type: "local";
  path: string;
}
