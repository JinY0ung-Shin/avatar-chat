import type { ScheduleKind } from "./routineSchedule.js";
import type { McpToolGroupId } from "../shared/mcpToolGroups.js";

export type AgentRuntime = "claude" | "local";

/**
 * A statically registered agent served by an external Noah-compatible gateway.
 * Connection details and credentials are server-only and must never be copied
 * into an AvatarSummary/AvatarDetail response.
 */
export interface ExternalAgentConfig {
  /** Operator-facing slug; the public avatar id is `external:${id}`. */
  id: string;
  displayName: string;
  alias: string;
  bio: string;
  persona: string;
  intro: string;
  hashtags: string[];
  /** Exact POST endpoint for the gateway's `/v1/agents/messages` API. */
  endpoint: string;
  /** Gateway agent implementation. v1 defaults to `claude`. */
  agent: string;
  /** Disabled entries stay in admin/history metadata but cannot be discovered or run. */
  enabled?: boolean;
  model?: string;
  /** Private upstream system instruction; never included in public avatar JSON. */
  system?: string;
  /** Private bearer token; never included in public avatar JSON. */
  apiKey?: string;
  /** Maximum time to receive upstream response headers. Defaults to 15s. */
  connectTimeoutMs?: number;
  /** Maximum silence between upstream SSE bytes. Defaults to 120s. */
  idleTimeoutMs?: number;
  /** Hard cap for one external turn. Defaults to 30 minutes. */
  totalTimeoutMs?: number;
  /**
   * Optional Noah group ACL. Omitted means public; a non-empty list means only
   * members of at least one listed group may discover or chat with this avatar.
   * This controls Noah visibility only and never grants Gateway tool privileges.
   */
  visibleToGroupIds?: string[];
}

/** Where an administrator-visible external avatar definition comes from. */
export type ExternalAgentSource = "environment" | "managed";

/**
 * Secret-free external avatar shape returned only from the admin API. Public
 * avatar endpoints expose a much smaller projection and never include these
 * connection/runtime fields.
 */
export interface AdminExternalAgent {
  id: string;
  displayName: string;
  alias: string;
  bio: string;
  persona: string;
  intro: string;
  hashtags: string[];
  endpoint: string;
  agent: string;
  enabled: boolean;
  model?: string;
  system?: string;
  visibleToGroupIds?: string[];
  connectTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  totalTimeoutSeconds?: number;
  source: ExternalAgentSource;
  /** The credential itself is write-only; admins receive only this flag. */
  apiKeySet: boolean;
  /** Used to guard destructive delete and endpoint reassignment. */
  conversationCount: number;
  /** Admin-set profile image present (stored outside the registry). */
  hasImage: boolean;
}

export type ExternalAgentApiKeyMode = "keep" | "set" | "clear";

/** Write contract shared by the external-avatar editor and admin API. */
export interface AdminExternalAgentInput {
  id: string;
  displayName: string;
  alias?: string;
  bio?: string;
  persona?: string;
  intro?: string;
  hashtags?: string[];
  endpoint: string;
  agent?: "claude";
  enabled?: boolean;
  model?: string;
  system?: string;
  visibleToGroupIds?: string[];
  connectTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  totalTimeoutSeconds?: number;
  apiKeyMode: ExternalAgentApiKeyMode;
  /** Accepted only with apiKeyMode="set" and never returned by the server. */
  apiKey?: string;
}

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
  /**
   * Concrete model id each composer TIER alias maps to, from the operator's
   * `ANTHROPIC_DEFAULT_<TIER>_MODEL` env, keyed by the modelTiers alias
   * (`opus`/`sonnet`/`haiku`). A tier with no env mapping is omitted (the SDK then
   * resolves the alias to the account default, which the app can't know). Surfaced
   * to the chat composer + describe_system so the user/avatar sees the real model.
   */
  defaultTierModels: Record<string, string>;
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
   * How long an avatar plugin clone may be reused before a chat/routine turn
   * refreshes it from git. 0 disables automatic refresh after the first clone.
   */
  pluginAutoRefreshIntervalMs: number;
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
   * Optional override for the SDK autocompact trigger: the working context
   * window (in tokens) the agent compacts near the top of. Maps to the SDK
   * `autoCompactWindow` option. Unset (the default) → the CLI uses the model's
   * full context window. Env `AUTO_COMPACT_WINDOW`; clamped to the SDK's
   * 100K–1M range, non-numeric/≤0 ignored. Lower it to compact earlier (keeps
   * each turn cheaper at the cost of more frequent summarization).
   */
  autoCompactWindow?: number;
  /**
   * Command that launches the upstream hex-ssh MCP server behind the app's
   * policy proxy. The image installs the package at build time and exposes it as
   * `hex-ssh-mcp` (the default) — avoiding a runtime `npx` download that fails
   * on a closed network. Override via `HEX_SSH_COMMAND` for local dev.
   */
  hexSshCommand: string;
  /** Command used to rewrite Bash tool calls through RTK when available. */
  rtkCommand: string;
  /** Server-only static registry loaded from `EXTERNAL_AGENTS_JSON`. */
  externalAgents?: ExternalAgentConfig[];
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
   * is off). Seeds every NEW conversation so the toggle choice persists across
   * conversations. `[]` = every group on (the default).
   */
  groupKnowledgeOffDefault: string[];
  /**
   * The owner's remembered chat-composer defaults, seeding every NEW conversation
   * so the picker's last choice persists across conversations. `null` = never
   * chosen → a new conversation falls back to the hardcoded server/SDK default.
   * `modelDefault` is a model-tier alias; `effortDefault` a reasoning-effort level;
   * `mcpToolGroupsDefault` the enabled MCP tool groups (`null` = every group on,
   * `[]` = explicitly all off). The per-conversation `selected_*` value still
   * overrides these for an already-started conversation.
   */
  modelDefault: string | null;
  effortDefault: string | null;
  mcpToolGroupsDefault: McpToolGroupId[] | null;
  /**
   * Names of the user's stored secrets (e.g. SSH_PRIVATE_KEY). Only the NAMES
   * are exposed — the encrypted values never leave the server. The avatar's
   * MCP tools receive them as subprocess env (injected by the owner's identity),
   * so they're invisible to the agent itself.
   */
  secretNames: string[];
  /**
   * Subset of `secretNames` the user opted into AGENT-SHELL exposure for
   * (per-secret toggle): those values are exported into the agent's Bash env
   * on elevated runs, with tool outputs redacted. Reserved git/SSH names are
   * excluded by policy regardless (`secretPolicy.ts`).
   */
  shellExposedSecretNames: string[];
  /** Public SSH key generated by the app for this user's avatar, safe to re-display. */
  sshPublicKey: string | null;
  /**
   * Groups the user belongs to. Members of a group auto-trust each other and
   * share the group's knowledge repo; `role` is the user's role within each.
   */
  groups: UserGroupMembership[];
  /**
   * Keys of the experimental (beta) features the owner has enabled for their
   * avatar (e.g. `["canvas"]`). Validated against the server registry
   * (`experimentalFeatures.ts`); unknown keys are dropped. `[]` = none enabled.
   */
  experimentalFeatures: string[];
  /**
   * Shared (communal) account: when true, trusted same-group teammates chatting
   * with this avatar may also UPDATE the owner's personal knowledge repo
   * (write/delete/move/scaffold/commit). Repo creation/connection settings stay
   * owner-only, and plain (non-group) viewers stay read-only. Off by default.
   */
  sharedAccount: boolean;
  /**
   * When the user dismissed first-run onboarding (ISO timestamp), or null if they
   * haven't yet. Server-persisted so the welcome modal shows ONCE per account —
   * across devices and surviving a localStorage clear — instead of every login.
   */
  onboardedAt: string | null;
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
  /** External avatars bypass Noah's local Claude/local runtime and tool stack. */
  runtime?: "native" | "external";
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

/**
 * Supported chat image-attachment media types. Mirrors what the Claude API
 * accepts as an `ImageBlockParam` base64 source, intersected with the formats a
 * browser can produce/preview. GIF is allowed in (the model reads it) but the
 * client downsizes to PNG/JPEG/WEBP, so it mostly appears on pasted/dropped GIFs.
 */
export type ImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

/**
 * An image attached to a user or assistant chat message. The bytes live on disk under
 * `dataDir/chat-images/<conversationId>/<id>.<ext>` (see `chatImages.ts`); this
 * is the metadata persisted on the message so the bubble can render the image
 * (`GET /api/conversations/:id/images/:imageId`) after reload. The model is fed
 * the bytes as an image content block on the turn — see {@link AgentImageInput}.
 */
export interface MessageAttachment {
  /** Stable id; also the on-disk filename stem and the serving-URL segment. */
  id: string;
  kind: "image";
  mediaType: ImageMediaType;
  /** Original filename, for the alt text / download name (optional). */
  name?: string;
  /** Optional agent-provided description shown below the image. */
  caption?: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Images attached to this message; absent/[] when none. */
  attachments?: MessageAttachment[];
  response: AgentResponse | null;
  createdAt: string;
}

/**
 * One image fed to the model as an `ImageBlockParam` on a chat turn (base64,
 * no `data:` prefix). The server decodes the uploaded data URL / reads the
 * stored file into this shape; {@link runClaudeAgent} turns it into a
 * structured SDK user message (text + image blocks) instead of a plain string.
 */
export interface AgentImageInput {
  mediaType: ImageMediaType;
  data: string;
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
  activeSessions: number;
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
  /**
   * Live context-window occupancy at the end of the turn — the SDK's
   * authoritative `getContextUsage().totalTokens` when available, else the final
   * request's prompt-size snapshot (input + cache read + cache creation, see
   * `mainAssistantContextTokens`). A snapshot, NOT the cumulative sum across the
   * turn's requests, so `inputTokens / contextWindow` is a meaningful fill %.
   * 0 marks a turn with no honest occupancy figure (the badge then shows
   * output-only).
   */
  inputTokens: number;
  /** Tokens the model generated this turn (cumulative across all requests). */
  outputTokens: number;
  /**
   * Of `outputTokens`, the portion spent on internal reasoning (extended
   * thinking), when the SDK reports it. Lets the badge separate reasoning from
   * the visible reply so a short answer with heavy thinking doesn't read as a
   * bogus "출력" count. Omitted/0 when the turn did no reasoning.
   */
  thinkingTokens?: number;
  /** The model's context-window size, if known (getContextUsage/modelUsage). */
  contextWindow?: number;
}

/**
 * One interactive control the avatar declares on a visual-canvas artifact. The
 * AVATAR only DECLARES these (it never emits executable JS — CSP-safe); the
 * client renders real form controls and posts the submitted value back through
 * the existing `/api/chat/respond` interactive-prompt path. Part of the
 * `canvas` experimental feature (#50).
 */
export interface CanvasControl {
  /**
   * The control kind. All render as native HTML form elements (CSP-safe):
   * - "buttons" → single/multi choice shown as option cards
   * - "text"    → a one-line or multiline freeform input
   * - "select"  → a dropdown (for many options where buttons get unwieldy)
   * - "slider"  → a numeric range (<input type=range>) with min/max/step
   * - "number"  → a precise numeric input (<input type=number>)
   * - "date"    → a calendar date picker, submitted as a "YYYY-MM-DD" string
   */
  type: "buttons" | "text" | "select" | "slider" | "number" | "date";
  /** Stable id used as the key in the submitted-values object. */
  id: string;
  /** Optional label shown above the control. */
  label?: string;
  /** buttons | select: the selectable options. */
  options?: { label: string; value?: string; description?: string }[];
  /** buttons: allow selecting more than one option. */
  multiSelect?: boolean;
  /** text: placeholder shown in the empty input. */
  placeholder?: string;
  /** text: render a multi-line textarea instead of a single-line input. */
  multiline?: boolean;
  /** slider | number: lower numeric bound. */
  min?: number;
  /** slider | number: upper numeric bound. */
  max?: number;
  /** slider | number: increment step. */
  step?: number;
  /**
   * Whether the user must provide a value before submitting. Defaults to TRUE
   * (preserving the original block-until-filled behavior); set false to let the
   * user skip this control.
   */
  required?: boolean;
  /** Initial value: slider/number start, select preselection, date initial. */
  defaultValue?: string | number;
}

/**
 * Supported visual-canvas content kinds. All are rendered client-side WITHOUT
 * executing avatar-authored JS: markdown/svg/html are sanitized (DOMPurify),
 * mermaid is rendered from text by the bundled mermaid library, and `vega` is a
 * compact Vega-Lite JSON spec rendered to SVG via the CSP-safe Vega expression
 * interpreter (no `Function` constructor) — so the strict same-origin CSP stays
 * unchanged (#50). `vega` lets the avatar declare a chart in a tiny spec instead
 * of hand-authoring verbose SVG, which is far cheaper in tokens.
 */
export type CanvasContentType =
  | "markdown"
  | "svg"
  | "html"
  | "mermaid"
  | "vega";

/**
 * A visual-canvas artifact the avatar showed in the side panel during a turn,
 * persisted on the assistant message's {@link AgentResponse} so the panel can be
 * rebuilt on reload and the conversation continued from it (#50).
 */
export interface CanvasArtifact {
  id: string;
  title: string;
  content: string;
  contentType: CanvasContentType;
  /** Declared interactive controls, if the avatar requested input. */
  controls?: CanvasControl[];
  /** The values the user submitted for `controls` (when they did). */
  submittedValues?: Record<string, unknown>;
  /**
   * How this canvas collects input (experimental interaction model):
   * - "blocking" → the run parks until the user submits (via /api/chat/respond)
   * - "async"    → the run completes; the user's later submission arrives as a NEW
   *   chat turn (via /api/chat/stream)
   * undefined = display-only (no controls).
   */
  interaction?: "blocking" | "async";
  /** The user may edit/annotate the content and send the edited version back as a new turn. */
  editable?: boolean;
  /** Current version number of this artifact (1-based; canvas version history). */
  currentVersion?: number;
  /** Total number of stored versions for this artifact. */
  versionCount?: number;
}

/** One entry in a canvas artifact's version history (canvas version history). */
export interface CanvasVersion {
  version: number;
  createdAt: string;
}

/**
 * A snapshot of the activity tree (sub-agents + tool/task/blocked rows) that ran
 * during a turn, kept on the assistant message so the COMPLETED bubble still shows
 * what the avatar did — otherwise the live activity tree vanishes the instant the
 * run finishes. Structurally mirrors the client's activity rows. `tools.kind ===
 * "task"` is kept for old stored snapshots; new clients store SDK tasks in
 * `tasks` instead.
 */
export interface AgentActivity {
  agents: {
    id: string;
    parentId: string;
    label: string;
    status: "running" | "done" | "failed";
    isMain: boolean;
  }[];
  tools: {
    id: string;
    agentId: string;
    kind: "tool" | "task" | "blocked";
    label: string;
    detail?: string;
    status: "running" | "done" | "failed" | "blocked";
  }[];
  tasks?: {
    id: string;
    agentId: string;
    label: string;
    detail?: string;
    status: "running" | "done" | "failed";
  }[];
}

export interface AgentResponse {
  kind: "text";
  runtime: "local" | "claude" | "external";
  summary: string;
  text: string;
  /** Per-turn token usage (Claude runtime only; omitted for local runs). */
  usage?: AgentUsage;
  /**
   * LEGACY: visual-canvas artifacts shown this turn. Canvas artifacts now persist
   * in the dedicated `canvas_artifacts`/`canvas_versions` tables (see store), so
   * new turns no longer write this field. Kept ONLY so pre-migration stored
   * `response_json` still parses and the one-time backfill can read it.
   */
  canvases?: CanvasArtifact[];
  /**
   * The plan the avatar submitted via ExitPlanMode this turn (plan mode), kept on
   * the assistant message so the dedicated plan card rebuilds on reload. The
   * latest plan of the turn wins. Display-only — autoApprove turns continue
   * automatically, so there is no accept/reject state to persist.
   */
  plan?: string;
  /**
   * The model's reasoning (extended-thinking) text for this turn, kept on the
   * assistant message so a collapsible "생각 과정" view rebuilds on reload.
   * Only captured on the streaming chat path (no viewer → not persisted).
   */
  thinking?: string;
  /** Activity-tree snapshot so the completed bubble keeps showing tool/agent runs. */
  activity?: AgentActivity;
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
  /**
   * The conversation this turn belongs to. Lets in-process MCP tools key
   * per-conversation state — e.g. `mcp__git_repo__open_repo` records the working
   * repo selection (repoWorkspace.ts) the chat route reads on the next turn.
   */
  conversationId?: string;
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
   * inbox (pending_requests) still keys off viewerIsOwner, so a trusted user gets
   * elevated tools WITHOUT the owner's gap inbox.
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
   * User-chosen model TIER (alias `opus`/`sonnet`/`haiku`) for this conversation,
   * from the chat composer. Resolved against env pin / admin override in
   * claudeAgent (env pin wins, then this tier, then the admin override). The alias
   * is passed straight to the SDK; the concrete model is the operator's call via
   * ANTHROPIC_DEFAULT_*_MODEL. Unset → server default resolution. (See modelTiers.ts.)
   */
  modelTier?: string;
  /**
   * User-chosen reasoning EFFORT level (`low`/`medium`/`high`/`xhigh`/`max`) for
   * this conversation, from the chat composer. Passed straight to the SDK as
   * `options.effort`; the SDK silently downgrades levels the selected model does
   * not support. Independent of the model pin. Unknown/unset → SDK default
   * (`high`). (See effortLevels.ts.)
   */
  effort?: string;
  /**
   * MCP tool groups enabled for this conversation/run. Undefined means the
   * server default (all groups) for backward compatibility with older clients.
   * The chat route validates and persists these IDs per conversation.
   */
  mcpToolGroups?: McpToolGroupId[];
  /**
   * Opt into model fallback: when the run fails on a transient model/server-side
   * error (overload/5xx/429/network), retry on the next-lower tier down the chain
   * (resolved model → … → haiku). Set ONLY for scheduled routines — headless runs
   * have no live stream, so re-running is clean. An env-pinned `ANTHROPIC_MODEL`
   * is a hard lock and disables fallback. Unset → single attempt (chat behavior).
   */
  modelFallback?: boolean;
  /**
   * Names of the avatar owner's configured secret-tab environment variables.
   * Values are never included. Set only for owner-driven turns: owner chats
   * AND owner-scheduled routines running with owner tool access.
   */
  secretNames?: string[];
  /**
   * Subset of `secretNames` the owner opted into agent-shell exposure for
   * (per-key toggle). Drives the standing prompt note that these are usable as
   * `$NAME` in Bash on elevated runs, with tool outputs redacted. Same gating
   * as `secretNames`.
   */
  shellExposedSecretNames?: string[];
  /**
   * Whether the avatar owner has connected a personal knowledge repo. Filled by
   * the server before building the Claude prompt; undefined means "unknown" for
   * direct unit calls.
   */
  knowledgeRepoConfigured?: boolean;
  /**
   * Whether the avatar owner has stored the internal GIT_TOKEN. Lets the
   * prompt guide direct knowledge-repo creation (via the repo tool) vs. asking
   * the owner to set a token first. Set only for owner, non-headless chat prompts.
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
   * Whether the avatar owner marked their account as a shared (communal)
   * account (`User.sharedAccount`). Filled by the server from the owner's row
   * before building the prompt (like `knowledgeRepoConfigured`); drives the
   * teammate-branch guidance that repo WRITES are allowed here, and the owner
   * self-state note (META-COGNITION). Undefined means "unknown"/false for
   * direct unit calls.
   */
  sharedAccount?: boolean;
  /**
   * Group names the (non-owner) viewer shares with the avatar owner — i.e. the
   * REASON this viewer is auto-trusted, when group co-membership is the source.
   * Lets the prompt explain why the current colleague is elevated
   * (META-COGNITION) instead of presenting trust as unexplained. Group
   * co-membership is the ONLY trust source, so this is empty for the owner and
   * for plain colleagues (a non-owner sharing no group).
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
  /**
   * Whether the avatar owner enabled the experimental `canvas` feature AND this
   * is an interactive (non-headless) turn where the canvas tool is registered.
   * Drives standing prompt guidance telling the avatar it can show visual
   * canvases via `mcp__canvas__show` (#50). Set for ALL viewer classes of such a
   * turn — colleagues see canvases too; it grants no elevation.
   */
  canvasEnabled?: boolean;
  /**
   * This interactive turn can publish PNG/JPEG/WebP/GIF files from its allowed
   * working directories into the assistant bubble with `show_file`.
   */
  fileOutputEnabled?: boolean;
  /**
   * Experimental (beta) feature keys enabled for the avatar owner. Surfaced in
   * the owner/routine self-state (META-COGNITION) so the avatar knows which beta
   * behaviors are active. Set only for owner-driven turns. (#50)
   */
  experimentalFeatures?: string[];
  /**
   * Admin tool/skill policy self-state (META-COGNITION): built-in tools /
   * skills the system administrator disabled deployment-wide. Set by
   * `runClaudeAgent` for every viewer class — a disabled skill can still
   * appear in the CLI's skill listing (stale discovery cache), so the standing
   * prompt note keeps the avatar from attempting or suggesting it.
   */
  adminDisabledTools?: string[];
  adminDisabledSkills?: string[];
  /**
   * The registered git repo the avatar opened as this conversation's **working
   * repository** (`mcp__git_repo__open_repo`): the repo's registered name. Its
   * clone is the SDK cwd, so the avatar edits/tests and commits locally with
   * native tools while remote git (push/sync) still flows through
   * `mcp__git_repo__*`. Drives the working-repo prompt guidance + the Bash-git
   * integrity policy.
   */
  activeRepoName?: string;
  /**
   * Extra writable directories to expose to the SDK beyond the plugin roots —
   * e.g. the per-conversation scratch workspace when the cwd has been repointed
   * at the opened working-repo clone.
   */
  additionalDirs?: string[];
  /**
   * Images attached to THIS turn's user message, fed to the model as image
   * content blocks. When present (and non-empty), `runClaudeAgent` sends a
   * structured SDK user message (the prompt text + these image blocks) instead
   * of a plain string prompt; empty/unset keeps the plain-string path unchanged.
   * Unused for headless turns.
   */
  images?: AgentImageInput[];
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
 * A scheduled task the avatar's owner creates: a prompt the avatar runs by
 * itself once, daily, weekly, or at a fixed interval (KST wall-clock for
 * once/daily/weekly). Results are appended to a dedicated routine conversation
 * the owner can inspect from the routine view.
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
  /** Whether the schedule runs once, daily, weekly, or at a fixed interval. */
  scheduleKind: ScheduleKind;
  /** Minutes from midnight **in Seoul time (KST)** (0..1439) the job fires at. */
  minuteOfDay: number;
  /** "HH:MM" rendering of minuteOfDay, for convenience on the client. */
  time: string;
  /** weekly only: sorted unique ints 0(Sun)..6(Sat); null otherwise. */
  daysOfWeek: number[] | null;
  /** interval only: minutes between firings (5..10080); null otherwise. */
  intervalMinutes: number | null;
  /** once only: YYYY-MM-DD in KST; null for recurring schedules. */
  runDate: string | null;
  enabled: boolean;
  /** Next scheduled firing (ISO, UTC); null while disabled or completed. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastError: string | null;
  /** Set after a one-time schedule has made its single execution attempt. */
  completedAt: string | null;
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
  runDate?: string | null;
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

/**
 * A node in the second-brain knowledge graph: one markdown note in the vault,
 * or a `[[dangling]]` link target with no matching note file.
 */
export interface KnowledgeGraphNode {
  /** Repo-relative path for a real note (e.g. "wiki/concepts/deploy.md"); `unresolved:<target>` for a dangling link. */
  id: string;
  /** Display label — the note's frontmatter `title`, its filename stem, or the raw link target when dangling. */
  label: string;
  /** Vault section for coloring: raw | sources | entities | concepts | synthesis | wiki | other | unresolved. */
  section: string;
  tags: string[];
  /** True when this node is only a `[[link]]` target with no backing note file. */
  dangling?: boolean;
}

/** A directed `[[wikilink]]` from one note to another (or to a dangling target). */
export interface KnowledgeGraphEdge {
  /** Source node id (the linking note's path). */
  source: string;
  /** Target node id (the linked note's path, or `unresolved:<target>`). */
  target: string;
}

/** The `[[wikilink]]` graph over a knowledge repo's `raw/`+`wiki/` notes. */
export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  /** True when the repo predates the vault layout (no `wiki/`/`raw/`) — client points at brain-migrate. */
  noVault?: boolean;
}

/** A single vault note's raw markdown, served to the graph view's content panel. */
export interface KnowledgeNote {
  /** Repo-relative path (a graph node id for a real note). */
  path: string;
  /** Raw markdown body (frontmatter included); the client renders + sanitizes it. */
  content: string;
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
