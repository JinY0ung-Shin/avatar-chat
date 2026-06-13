import type { ScheduleKind } from "./routineSchedule.js";

export type AgentRuntime = "claude" | "local";

/**
 * Minimal avatar-owner descriptor the in-process MCP tool servers
 * (`agent/*Tools.ts`) act on behalf of: identity for commit attribution and the
 * username/displayName fallbacks. `alias` is the avatar's self-name (optional).
 */
export interface AgentOwner {
  id: string;
  username: string;
  displayName: string;
  alias?: string;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  dbPath: string;
  sessionSecret: string;
  agentRuntime: AgentRuntime;
  anthropicApiKey?: string;
  /** Pins the Claude model the agent runs (SDK `model` option). Unset → SDK default. */
  anthropicModel?: string;
  readOnlyTools: string[];
  /** Default host used when a repo is entered as owner/repo. */
  githubHost: string;
  /**
   * Deployment-wide Confluence base URL (env `CONFLUENCE_URL`). The PAT itself
   * is user-scoped and stored as a `CONFLUENCE_PAT` secret.
   */
  confluenceUrl?: string;
  /**
   * Optional PEM CA file path (env `GITHUB_CA_CERT`) trusted for BOTH TLS stacks
   * the app uses to reach `githubHost`: Node `fetch` and every `git` clone/push.
   * `create_repo` also passes it to gh as `SSL_CERT_FILE`. Applied once at
   * startup by `applyCustomGithubCa`; unset means public/system CAs only.
   */
  githubCaCert?: string;
  /** Repo-bundled plugin dir loaded for EVERY avatar (default skills). */
  defaultPluginsDir: string;
  /**
   * Where the SDK persists per-conversation session transcripts (its
   * `CLAUDE_CONFIG_DIR`). Lives under `dataDir` so resumable sessions survive a
   * server/container restart, instead of the SDK's default `~/.claude`.
   */
  agentSessionsDir: string;
  /**
   * Max agent turns (model inferences) per chat reply. Each tool call consumes a
   * turn, so tool/skill/subagent-heavy replies need plenty of headroom — too low
   * and the SDK aborts mid-task with `error_max_turns`. Defaults to 1000 (env
   * `MAX_TURNS`).
   */
  maxTurns: number;
  /**
   * Command that launches the upstream hex-ssh MCP server behind the app's
   * policy proxy. The image installs the package at build time and exposes it as
   * `hex-ssh-mcp` (the default) — avoiding a runtime `npx` download that fails
   * on a closed network. Override via `HEX_SSH_COMMAND` for local dev.
   */
  hexSshCommand: string;
  /** Command used to rewrite Bash tool calls through RTK when available. */
  rtkCommand: string;
}

/**
 * Who can discover and chat with an avatar:
 * - `public`  — everyone (visible in 탐색 to all users)
 * - `group`   — only the owner's group teammates (also mutually elevated)
 * - `private` — only the owner
 * Trust/elevation is a SEPARATE axis derived purely from group co-membership
 * (see `Store.isTrustedFor`); visibility only controls reach/discovery.
 */
export type AvatarVisibility = "public" | "group" | "private";

/**
 * Public user shape returned to clients. NEVER includes password_hash or secret
 * values — the internal git token is exposed only as the `gitTokenSet` flag.
 */
export interface User {
  id: string;
  username: string;
  displayName: string;
  /** How the avatar names ITSELF in chat (별칭); empty falls back to displayName. */
  alias: string;
  bio: string;
  persona: string;
  /** First-person self-introduction the avatar generates, shown atop the chat capabilities panel. */
  intro: string;
  /** Capability hashtags (bare, no "#") the avatar declares for discovery/search. */
  hashtags: string[];
  hasImage: boolean;
  /** Who can discover and chat with this avatar — see {@link AvatarVisibility}. */
  visibility: AvatarVisibility;
  roles: string[];
  pluginCount: number;
  /** True when the internal GIT_TOKEN secret is stored (the token itself is never sent). */
  gitTokenSet: boolean;
  /** Git commit author identity for knowledge-repo commits (safe to expose). */
  gitIdentityName: string | null;
  gitIdentityEmail: string | null;
  /** The user's personal knowledge repo (`owner/repo` or git URL) and branch. */
  knowledgeRepo: string | null;
  knowledgeBranch: string | null;
  /**
   * For a knowledge repo that's a marketplace of many plugins: the subset of
   * plugin names the avatar loads. `null` means "load all" (the default) — the
   * repo is the avatar's by default, so all its plugins are used unless the
   * owner deselects some.
   */
  knowledgeSelected: string[] | null;
  /**
   * The owner's DEFAULT group-knowledge OFF-set (group ids whose shared knowledge
   * is off). Seeds every NEW conversation — including the auto-greeting, which
   * fires before the composer toggle can be touched — so the toggle choice
   * persists across conversations. `[]` = every group on (the default).
   */
  groupKnowledgeOffDefault: string[];
  /**
   * Names of the user's stored secrets (e.g. SSH_PRIVATE_KEY). Only the NAMES
   * are exposed — the encrypted values never leave the server. The avatar's
   * MCP tools receive them as subprocess env (injected by the owner's identity),
   * so they're invisible to the agent itself.
   */
  secretNames: string[];
  /** Public SSH key generated by the app for this user's avatar, safe to re-display. */
  sshPublicKey: string | null;
  /**
   * Groups the user belongs to. Members of a group auto-trust each other and
   * share the group's knowledge repo; `role` is the user's role within each.
   */
  groups: UserGroupMembership[];
}

export interface Plugin {
  id: string;
  repo: string;
  ref: string | null;
  label: string | null;
  enabled: boolean;
  // For marketplace repos (many plugins in one repo): names of the plugins to
  // load. `null` means "load all" (the default, backward-compatible).
  selected: string[] | null;
  // ISO timestamp of the last successful git sync, or null if never synced.
  lastSyncedAt: string | null;
  createdAt: string;
}

/** A user-registered general-purpose git repository managed by MCP tools. */
export interface GitRepository {
  userId: string;
  name: string;
  repo: string;
  branch: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

/** A member's role within a group. A group `admin` manages members + the shared repo. */
export type GroupRole = "admin" | "member";

/**
 * A group created by a system admin. Members of the same group automatically
 * trust each other (mutual `elevated` access — see `isTrustedFor`), and the
 * group has one shared knowledge repo that only group admins may edit.
 */
export interface Group {
  id: string;
  name: string;
  description: string;
  /** The group's shared knowledge repo (`owner/repo` or git URL) + branch. */
  knowledgeRepo: string | null;
  knowledgeBranch: string | null;
  /** Subset of the group repo's plugins to load; `null` = load all. */
  knowledgeSelected: string[] | null;
  /** User id of the system admin who created the group (may be gone). */
  createdBy: string | null;
  createdAt: string;
}

/** A member of a group, with their role within it (for the management/roster UI). */
export interface GroupMember {
  userId: string;
  username: string;
  displayName: string;
  hasImage: boolean;
  role: GroupRole;
  /** This member's avatar visibility (the roster chat link is shown unless `private`). */
  visibility: AvatarVisibility;
  joinedAt: string | null;
}

/** Admin-dashboard summary of a group, with member counts. */
export interface AdminGroupSummary extends Group {
  memberCount: number;
  adminCount: number;
}

/** A group the current user belongs to — surfaced on `User` and the roster. */
export interface UserGroupMembership {
  id: string;
  name: string;
  role: GroupRole;
  /** True when the group has a shared knowledge repo connected. */
  knowledgeRepoConfigured: boolean;
}

/** A plugin found inside a cloned repo, surfaced to the UI for selection. */
export interface RepoPluginEntry {
  name: string;
  // false → listed in the marketplace manifest but missing a valid
  // `.claude-plugin/plugin.json`, so it can't actually be loaded.
  loadable: boolean;
}

/** What a cloned repo contains, for the plugin-selection UI. */
export interface RepoPluginContents {
  // "single": one plugin at the repo root; selection doesn't apply.
  // "marketplace": many plugins; the UI lets the owner pick a subset.
  // "none": not a Claude plugin repo.
  kind: "single" | "marketplace" | "none";
  plugins: RepoPluginEntry[];
}

/**
 * A skill the avatar can invoke, surfaced to colleagues (and the owner) on the
 * chat screen so they can see what the avatar is equipped to do. Read from a
 * plugin's `skills/<name>/SKILL.md` frontmatter.
 */
export interface SkillInfo {
  name: string;
  description: string;
  /** Where the skill came from: "default" (bundled) or the plugin repo slug. */
  source: string;
}

export interface AvatarSummary {
  id: string;
  username: string;
  displayName: string;
  /** The avatar's self-name (별칭); empty falls back to displayName. */
  alias: string;
  bio: string;
  /** Capability hashtags (bare, no "#") for discovery cards + cross-avatar search. */
  hashtags: string[];
  hasImage: boolean;
  pluginCount: number;
  /** Who can discover and chat with this avatar — see {@link AvatarVisibility}. */
  visibility: AvatarVisibility;
  updatedAt: string | null;
  /**
   * True when the viewer shares a group with this avatar's owner (so they
   * auto-trust each other). Set by `listPublishedAvatars`; drives the 탐색
   * "같은 그룹" badge + group-priority ordering. Undefined where not computed.
   */
  sharesGroup?: boolean;
}

export interface AvatarDetail extends AvatarSummary {
  persona: string;
  /** First-person self-introduction shown atop the chat capabilities panel. */
  intro: string;
  isOwn: boolean;
  /**
   * True when the viewer may use tools at the owner's level — they're the owner
   * (isOwn) OR a trusted user. Drives the chat UI (hide the "read-only" label).
   */
  elevated: boolean;
  plugins: { repo: string; label: string | null }[];
}

export interface ConversationSummary {
  id: string;
  avatarUserId: string;
  avatarDisplayName: string;
  title: string;
  updatedAt: string;
  isRoutine: boolean;
  routineId: string | null;
  routinePrompt: string | null;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  response: AgentResponse | null;
  createdAt: string;
}

export interface AgentConversationMessage {
  role: "user" | "assistant";
  content: string;
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
  visibility: AvatarVisibility;
  /** True when the account is suspended (blocked from logging in / pending approval). */
  suspended: boolean;
  hasImage: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

/** How new self-service signups are handled. Always allows the very first
 *  (admin-bootstrap) account regardless of mode. */
export type SignupMode = "open" | "closed" | "approval";

/** Deployment-wide counts for the admin dashboard. */
export interface AdminStats {
  users: number;
  admins: number;
  suspended: number;
  /** Count of avatars with `public` visibility (discoverable by everyone). */
  publicAvatars: number;
  conversations: number;
  messages: number;
  openRequests: number;
  activeRoutines: number;
  activeSessions: number;
  groups: number;
}

/** Per-user breakdown shown when an admin expands a row. */
export interface AdminUserDetail extends AdminUserSummary {
  /** Conversations this user started (as an owner talking to avatars). */
  conversationsStarted: number;
  /** Conversations other people had with THIS user's avatar. */
  conversationsReceived: number;
  pluginCount: number;
  secretCount: number;
  routinesTotal: number;
  routinesActive: number;
  openRequests: number;
  activeSessions: number;
  gitTokenSet: boolean;
  knowledgeRepoSet: boolean;
}

/** Token usage for a single chat turn, surfaced to the client for display. */
export interface AgentUsage {
  /** Prompt tokens fed in this turn (input + cache read + cache creation). */
  inputTokens: number;
  /** Tokens the model generated this turn. */
  outputTokens: number;
  /** The model's context-window size, if the SDK reported it. */
  contextWindow?: number;
}

export interface AgentResponse {
  kind: "text";
  runtime: "local" | "claude";
  summary: string;
  text: string;
  /** Per-turn token usage (Claude runtime only; omitted for local runs). */
  usage?: AgentUsage;
  raw?: unknown;
}

export interface AgentAvatar {
  id: string;
  displayName: string;
  /** The avatar's self-name (별칭); empty falls back to displayName. */
  alias: string;
  persona: string;
}

export interface AgentRequest {
  message: string;
  avatar: AgentAvatar;
  /** Per-avatar working directory the SDK runs in (filesystem isolation). */
  cwd?: string;
  /**
   * SDK session id to resume (the prior turn's session for THIS conversation).
   * When set, the SDK reloads that session's transcript so the model keeps the
   * conversation's context instead of starting fresh. Unset → a new session.
   */
  resumeSessionId?: string;
  /**
   * Stored transcript fallback used only when no SDK session id is available.
   * Normal conversations continue through SDK `resume`; this keeps first-turn
   * cancellations or expired SDK transcripts from losing the visible context.
   */
  conversationHistory?: AgentConversationMessage[];
  /** The user currently chatting (may differ from the avatar's owner). */
  viewerUserId?: string;
  viewerName?: string;
  /** True when the viewer IS the avatar's owner (viewer.id === avatar.id). */
  viewerIsOwner?: boolean;
  /**
   * True when the viewer may use tools at the OWNER's permission level — i.e. the
   * owner themselves OR a designated trusted user. Gates the tool hook (write/Bash
   * run instead of read-only). DISTINCT from viewerIsOwner: the owner-only knowledge
   * inbox (pending_requests) and the opening greeting still key off viewerIsOwner,
   * so a trusted user gets elevated tools WITHOUT the owner's gap inbox/greeting.
   * Headless runs normally stay read-only; owner-scheduled routines opt into
   * owner-level tools through `allowHeadlessTools`.
   */
  elevated?: boolean;
  /**
   * Internal safety valve for owner-scheduled routines. `headless` still means
   * no questions/prompts are possible, but this lets the routine run with the
   * same owner tool permissions as a normal owner chat.
   */
  allowHeadlessTools?: boolean;
  /**
   * True when the owner just opened a fresh conversation with their own avatar
   * and no message was typed yet: the avatar greets first and reports any
   * pending info requests. Only meaningful together with viewerIsOwner.
   */
  greeting?: boolean;
  /**
   * True for unattended runs (scheduled routines): no human is present, so the
   * agent must not ask questions, interactive permission prompts are denied,
   * and knowledge writes are blocked — the run is strictly read-only.
   */
  headless?: boolean;
  /**
   * Auto-approve tool use: skip the interactive permission prompt and run
   * non-read-only tools without asking. Honored on the elevated, non-headless
   * path (`elevated && !headless`) for owner AND trusted users alike — the tool
   * gate (read-only deny for non-elevated viewers) is the real safety boundary,
   * so auto-approve is safe to apply broadly. A headless routine or a plain
   * colleague chat stays read-only regardless.
   */
  autoApprove?: boolean;
  /**
   * Names of the avatar owner's configured secret-tab environment variables.
   * Values are never included. Set only for owner-driven turns: owner chats
   * AND owner-scheduled routines running with owner tool access.
   */
  secretNames?: string[];
  /**
   * Whether the avatar owner has connected a personal knowledge repo. Filled by
   * the server before building the Claude prompt; undefined means "unknown" for
   * direct unit calls.
   */
  knowledgeRepoConfigured?: boolean;
  /**
   * Whether the avatar owner has stored the internal GIT_TOKEN. Lets the
   * greeting offer to create the knowledge repo directly (via the repo tool)
   * vs. asking the owner to set a token first. Set only for owner, non-headless
   * chat prompts.
   */
  gitTokenSet?: boolean;
  /**
   * GitHub host the server is currently configured to use for shorthand repos
   * and repo creation. Safe to show in prompts/tool descriptions; it is not a
   * credential.
   */
  githubHost?: string;
  /** Whether the deployment has a Confluence host configured. */
  confluenceUrlConfigured?: boolean;
  /** Whether the avatar owner has stored a Confluence PAT secret. */
  confluencePatConfigured?: boolean;
  /**
   * Groups the avatar owner belongs to, with role + whether each has a shared
   * knowledge repo. Injected into the prompt so the avatar knows its group
   * context (META-COGNITION). Set only for owner-driven turns (owner chats and
   * owner-scheduled routines) — group repo tools register on the same gate.
   */
  groupMemberships?: UserGroupMembership[];
  /**
   * Group names the (non-owner) viewer shares with the avatar owner — i.e. the
   * REASON this viewer is auto-trusted, when group co-membership is the source.
   * Lets the prompt explain why the current colleague is elevated
   * (META-COGNITION) instead of presenting trust as unexplained. Empty for the
   * owner, for directly-trusted viewers, and for plain colleagues.
   */
  trustedViaGroups?: string[];
  /**
   * Standing CLAUDE.md memory read from the avatar's knowledge repos and injected
   * into the prompt every turn (push, unlike on-demand skills). `personal` is the
   * owner's personal repo root CLAUDE.md; `groups` are the enabled group repos'.
   * The server (chat route / scheduler) loads + caps it; intro/hashtag generation
   * leaves it unset. Group filtering reflects the owner-only per-conversation
   * group-knowledge toggle.
   */
  knowledgeMemory?: {
    personal?: string | null;
    groups?: { name: string; content: string }[];
  };
}

/**
 * A gap in the avatar's knowledge: something a colleague asked that the avatar
 * didn't know, queued in the owner's inbox. The owner clears it once handled
 * (e.g. after teaching the avatar via a plugin) — there is no stored answer.
 */
export interface KnowledgeRequest {
  id: string;
  avatarUserId: string;
  askerUserId: string | null;
  askerName: string | null;
  question: string;
  status: "open" | "resolved";
  createdAt: string;
}

/** In-app message an avatar leaves for its owner to notice later. */
export interface AvatarNotification {
  id: string;
  ownerUserId: string;
  avatarUserId: string;
  avatarDisplayName: string;
  title: string;
  message: string;
  conversationId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * A recurring task the avatar's owner schedules: a prompt the avatar runs by
 * itself on a daily, weekly, or interval schedule (KST wall-clock for daily/
 * weekly). Results are appended to a dedicated routine conversation the owner
 * can inspect from the routine view.
 */
export interface RoutineJob {
  id: string;
  /** The avatar (and owner — owner chats with their own avatar). */
  avatarUserId: string;
  /** The dedicated conversation routine results are appended to. */
  conversationId: string;
  /** Optional human label for the routine; null when unset. */
  name: string | null;
  /** The message the avatar runs on each firing. */
  prompt: string;
  /** How the schedule recurs: daily, weekly, or fixed interval. */
  scheduleKind: ScheduleKind;
  /** Minutes from midnight **in Seoul time (KST)** (0..1439) the job fires at. */
  minuteOfDay: number;
  /** "HH:MM" rendering of minuteOfDay, for convenience on the client. */
  time: string;
  /** weekly only: sorted unique ints 0(Sun)..6(Sat); null otherwise. */
  daysOfWeek: number[] | null;
  /** interval only: minutes between firings (15..10080); null otherwise. */
  intervalMinutes: number | null;
  enabled: boolean;
  /** Next scheduled firing (ISO, UTC); null while disabled. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastError: string | null;
  createdAt: string;
}

/**
 * The optional schedule-field patch shared by `createRoutineJob`/
 * `updateRoutineJob`: every schedule field is optional, and callers supplying a
 * subset leave the rest at their default (create) or current value (update).
 */
export interface RoutineSchedulePatch {
  scheduleKind?: ScheduleKind;
  minuteOfDay?: number;
  daysOfWeek?: number[] | null;
  intervalMinutes?: number | null;
}

export interface PluginRoot {
  type: "local";
  path: string;
}

/** A file or directory entry in a user's knowledge-repo working tree. */
export interface KnowledgeRepoTreeEntry {
  /** Path relative to the repo root, POSIX-separated (e.g. "skills/foo/SKILL.md"). */
  path: string;
  type: "file" | "dir";
}

/** Working-tree state of a user's knowledge-repo clone. */
export interface KnowledgeRepoStatus {
  /** The configured repo (`owner/repo` or URL), or null if none set. */
  repo: string | null;
  branch: string | null;
  /** True once the repo has been cloned to disk. */
  cloned: boolean;
  /** Paths (relative) with uncommitted changes. */
  dirty: string[];
}
