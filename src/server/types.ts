export type UserRole = "owner" | "colleague";
export type ChatMode = "owner" | "colleague";
export type AgentRuntime = "auto" | "claude" | "local";

export interface AppConfig {
  port: number;
  dataDir: string;
  sessionSecret: string;
  ownerSetupCode: string;
  defaultProjectScope: string;
  marketplaceSource: string;
  marketplaceRef?: string;
  githubToken?: string;
  agentRuntime: AgentRuntime;
  anthropicApiKey?: string;
  colleagueAllowedTools: string[];
  ownerPermissionMode: string;
}

export interface User {
  id: string;
  name: string;
  role: UserRole;
  projectScope: string;
  createdAt: string;
  lastSeenAt?: string;
}

export interface Invite {
  id: string;
  label: string;
  codeHash: string;
  codePreview: string;
  role: UserRole;
  projectScope: string;
  maxUses: number;
  uses: number;
  createdBy: string;
  createdAt: string;
  revokedAt?: string;
}

export interface Session {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  userId: string;
  mode: ChatMode;
  role: "user" | "assistant" | "system";
  content: string;
  response?: AgentResponse;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorUserId: string;
  actorName: string;
  mode: ChatMode;
  action: string;
  skillName?: string;
  pluginName?: string;
  runtime?: "local" | "claude" | "blocked";
  status: "success" | "blocked" | "error";
  detail: string;
  createdAt: string;
}

export interface AppState {
  users: User[];
  invites: Invite[];
  sessions: Session[];
  messages: StoredMessage[];
  audit: AuditEvent[];
}

export interface MarketplaceCatalog {
  name: string;
  owner?: { name?: string };
  plugins: MarketplacePluginEntry[];
}

export interface MarketplacePluginEntry {
  name: string;
  description?: string;
  version?: string;
  source: string | MarketplaceSourceObject;
  category?: string;
  tags?: string[];
}

export interface MarketplaceSourceObject {
  source: "github" | "url" | "git-subdir" | "npm";
  repo?: string;
  url?: string;
  path?: string;
  ref?: string;
  sha?: string;
  package?: string;
  version?: string;
}

export interface AvatarCommandManifest {
  commands?: AvatarCommand[];
}

export interface AvatarCommand {
  name: string;
  description: string;
  mode: ChatMode | "both";
  readOnly: boolean;
  projectScoped?: boolean;
  match?: string[];
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface DiscoveredPlugin {
  name: string;
  description?: string;
  version?: string;
  rootPath: string;
  source: MarketplacePluginEntry["source"];
  commands: AvatarCommand[];
  tags: string[];
}

export interface SkillTable {
  columns: string[];
  rows: Record<string, string | number | boolean | null>[];
}

export interface AgentResponse {
  kind: "text" | "table";
  title?: string;
  summary: string;
  text?: string;
  table?: SkillTable;
  runtime: "local" | "claude" | "blocked";
  pluginName?: string;
  skillName?: string;
  raw?: unknown;
}

export interface AgentRequest {
  message: string;
  mode: ChatMode;
  user: User;
}
