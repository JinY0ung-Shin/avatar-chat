export type AgentRuntime = "claude" | "local";

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
  githubToken?: string;
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
   * Command that launches the hex-ssh MCP server (remote-server access). The
   * image installs the package at build time and exposes it as `hex-ssh-mcp`
   * (the default) — avoiding a runtime `npx` download that fails on a closed
   * network. Override via `HEX_SSH_COMMAND` (e.g. for dev where the global bin
   * isn't present, set it to a wrapper or an `npx`-based launcher).
   */
  hexSshCommand: string;
  /** Minimum log level (trace|debug|info|warn|error|fatal|silent). Defaults to "info", "silent" in test. */
  logLevel: string;
}

/**
 * Public user shape returned to clients. NEVER includes password_hash or the
 * encrypted git token — the token is exposed only as the `gitTokenSet` flag.
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
  hasImage: boolean;
  published: boolean;
  roles: string[];
  pluginCount: number;
  /** True when a personal GitHub token is stored (the token itself is never sent). */
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
   * Names of the user's stored secrets (e.g. SSH_PRIVATE_KEY). Only the NAMES
   * are exposed — the encrypted values never leave the server. The avatar's
   * MCP tools receive them as subprocess env (injected by the owner's identity),
   * so they're invisible to the agent itself.
   */
  secretNames: string[];
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
  hasImage: boolean;
  pluginCount: number;
  published: boolean;
  updatedAt: string | null;
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
   * A headless routine is never elevated (stays strictly read-only).
   */
  elevated?: boolean;
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
   * Values are never included. Set only for owner, non-headless chat prompts.
   */
  secretNames?: string[];
  /**
   * Whether the avatar owner has connected a personal knowledge repo. Filled by
   * the server before building the Claude prompt; undefined means "unknown" for
   * direct unit calls.
   */
  knowledgeRepoConfigured?: boolean;
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

/**
 * A recurring task the avatar's owner schedules: a prompt the avatar runs by
 * itself once a day at a chosen local time. Results are appended to a dedicated
 * conversation the owner can open like any other chat.
 */
export interface RoutineJob {
  id: string;
  /** The avatar (and owner — owner chats with their own avatar). */
  avatarUserId: string;
  /** The dedicated conversation routine results are appended to. */
  conversationId: string;
  /** The message the avatar runs on each firing. */
  prompt: string;
  /** Minutes from midnight **in Seoul time (KST)** (0..1439) the job fires at. */
  minuteOfDay: number;
  /** "HH:MM" rendering of minuteOfDay, for convenience on the client. */
  time: string;
  enabled: boolean;
  /** Next scheduled firing (ISO, UTC); null while disabled. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastError: string | null;
  createdAt: string;
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
