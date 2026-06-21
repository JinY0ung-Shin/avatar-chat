import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  AgentRequest,
  AgentResponse,
  AgentUsage,
  AgentOwner,
  AgentImageInput,
  PluginRoot,
} from "../types.js";
import type { Store } from "../store.js";
import { CLAUDE_OAUTH_TOKEN_KEY } from "../store.js";
import type { AgentEvents } from "./events.js";
import logger from "../logger.js";
import { knownHostsPath } from "../sshTrust.js";
import {
  EXTERNAL_GIT_TOKEN_SECRET_NAME,
  INTERNAL_GIT_TOKEN_SECRET_NAME,
} from "../gitCredentials.js";
import {
  HEX_SSH_SERVER_NAME,
  allowedHexSshToolsForViewer,
  viewerClassForAgentRequest,
  type HexSshViewerClass,
} from "../hexSshPolicy.js";
import { isRecord, asString } from "./agentUtils.js";
import {
  isModelTier,
  DEFAULT_MODEL_TIER,
  MODEL_TIER_IDS,
} from "../modelTiers.js";
import { isEffortLevel } from "../effortLevels.js";
import { summarizeOwnerState } from "./ownerState.js";
import { buildPrompt } from "./promptBuilder.js";
import {
  buildPreToolUseHook,
  rewriteBashCommandWithRtk,
  TASK_ORCHESTRATION_TOOLS,
} from "./preToolUseHook.js";
import {
  createLoopState,
  extractMainAssistantText,
  handleAssistantMessage,
  handleStreamEvent,
  handleSystemEvent,
  handleUserMessage,
  interpretResult,
  mainAssistantContextTokens,
  streamStartContextTokens,
  finalizeTurnUsage,
  resultErrorMessage,
  traceSdkMessage,
} from "./sdkMessageHandlers.js";
import { effectiveMcpToolGroups } from "../../shared/mcpToolGroups.js";

// Re-export the symbols moved into sibling modules so existing import paths
// (app.ts, index.ts, tests/units.test.ts, infra/agent-core/… tests) keep
// resolving against this module unchanged.
export { buildPrompt } from "./promptBuilder.js";
export {
  buildPreToolUseHook,
  rewriteBashCommandWithRtk,
} from "./preToolUseHook.js";
export { interpretResult, resultErrorMessage } from "./sdkMessageHandlers.js";

const agentLogger = logger.child({ module: "agent" });
const GIT_CREDENTIAL_ENV_NAMES = [
  INTERNAL_GIT_TOKEN_SECRET_NAME,
  EXTERNAL_GIT_TOKEN_SECRET_NAME,
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;
const SSH_MCP_SECRET_ENV_NAMES = [
  "SSH_PRIVATE_KEY",
  "SSH_PASSPHRASE",
  "SSH_PASSWORD",
  "SSH_USER",
  "SSH_USERNAME",
  "ALLOWED_HOSTS",
  "ALLOWED_HOST_FINGERPRINTS",
] as const;

export function withoutGitCredentialEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const name of GIT_CREDENTIAL_ENV_NAMES) {
    delete out[name];
  }
  return out;
}

// App-internal secrets the agent subprocess must NEVER be able to read from its
// environment. SESSION_SECRET is the AES-256-GCM master key for EVERY user's
// at-rest secrets (git tokens, the secret vault, the Claude subscription token):
// a Bash-capable elevated viewer that read it out of the subprocess env (or
// /proc) could decrypt all tenants' secrets straight out of the shared DB. The
// subprocess never opens the app DB, so stripping it costs nothing. (Git
// credentials are stripped separately above — they flow only through the
// app-managed git MCP bridge.)
const SENSITIVE_APP_ENV_NAMES = ["SESSION_SECRET"] as const;

export function agentSubprocessEnv(
  baseEnv: Record<string, string | undefined>,
  agentSessionsDir: string,
): Record<string, string | undefined> {
  const env = withoutGitCredentialEnv(baseEnv);
  for (const name of SENSITIVE_APP_ENV_NAMES) {
    delete env[name];
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: agentSessionsDir,
  };
}

export function sshMcpSecretEnv(
  ownerSecrets: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SSH_MCP_SECRET_ENV_NAMES) {
    const value = ownerSecrets[name];
    if (value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

export interface AgentToolAccess {
  viewerIsOwner: boolean;
  headless: boolean;
  allowHeadlessTools: boolean;
  /** Owner-level tool access: owner AND (non-headless OR a headless run that opted in). */
  ownerToolAccess: boolean;
  /** Elevated (owner OR trusted) tool access, with the same headless gating. */
  elevatedToolAccess: boolean;
  /** Owner OR trusted, IGNORING headless — gates the auto-approve path. */
  elevated: boolean;
  autoApprove: boolean;
  hexSshViewerClass: HexSshViewerClass;
}

/**
 * Derive a run's tool-permission level from the request. Pure and exported so it
 * can be unit-tested directly: because the PreToolUse hook auto-allows every
 * `mcp__*` tool, these booleans are the REAL gate between a run and the owner-only
 * tools. A regression that, e.g., passed raw `viewerIsOwner` through would
 * silently grant headless intro/hashtag-generation runs full owner repo-write
 * access — so the four viewer classes are pinned in tests.
 */
export function deriveAgentToolAccess(request: AgentRequest): AgentToolAccess {
  const viewerIsOwner = Boolean(request.viewerIsOwner);
  const headless = Boolean(request.headless);
  const allowHeadlessTools = Boolean(request.allowHeadlessTools);
  // A headless run is tool-restricted UNLESS it explicitly opted in (scheduled
  // owner routines do). `!headlessRestricted` === `(!headless || allowHeadlessTools)`.
  const headlessRestricted = headless && !allowHeadlessTools;
  const ownerToolAccess = viewerIsOwner && !headlessRestricted;
  const elevatedToolAccess =
    (viewerIsOwner || Boolean(request.elevated)) && !headlessRestricted;
  const elevated = viewerIsOwner || Boolean(request.elevated);
  const autoApprove = Boolean(request.autoApprove);
  const hexSshViewerClass = viewerClassForAgentRequest({
    viewerIsOwner: ownerToolAccess,
    elevated: elevatedToolAccess,
    headless: headlessRestricted,
  });
  return {
    viewerIsOwner,
    headless,
    allowHeadlessTools,
    ownerToolAccess,
    elevatedToolAccess,
    elevated,
    autoApprove,
    hexSshViewerClass,
  };
}

/**
 * Build the "streaming input" prompt for a turn that carries images: a single
 * SDK user message whose content is the full prompt text followed by one image
 * block per attachment. Yielding exactly one message and returning closes the
 * input stream, so the SDK runs a single turn (same as a string prompt). The
 * SDK's `query` is typed loosely here (`input: unknown`), so the SDKUserMessage
 * shape is constructed inline; `parent_tool_use_id: null` marks a top-level turn.
 */
export async function* buildImageQueryPrompt(
  promptText: string,
  images: AgentImageInput[],
): AsyncGenerator<Record<string, unknown>> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    uuid: randomUUID(),
    shouldQuery: true,
    message: {
      role: "user",
      content: [
        { type: "text", text: promptText },
        ...images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.data,
          },
        })),
      ],
    },
  };
}

// HTTP statuses that indicate a transient model/server-side condition worth
// retrying on a different model (overload/rate-limit/5xx/timeout).
const RETRYABLE_MODEL_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

// Appended to the prompt on the one-shot empty-turn retry (see emptyTurnRetryTried).
// Agent-facing → English. Steers the model to emit a visible text answer after a
// turn that produced only an (invisible) thinking block.
const EMPTY_TURN_RETRY_NUDGE =
  "[note] Your previous turn ended with internal reasoning only and produced no " +
  "visible reply. Answer the user's message now as plain text — do not stop after thinking.";

/**
 * Whether an SDK/query failure looks like a transient MODEL or SERVER-side
 * problem (overloaded, rate-limited, 5xx, network) — as opposed to a genuine
 * error (bad request, auth, a tool failure). Used to decide model fallback.
 * Inspects an `Anthropic`-style numeric `status` first, then the message text.
 */
/**
 * True when the SDK failed because a resumed session id has no transcript on
 * disk — e.g. the agent-sessions dir wasn't preserved across a redeploy, or the
 * transcript was cleaned up while the DB still holds the id. The CLI surfaces
 * this as "No conversation found with session ID …". We self-heal by re-running
 * the turn WITHOUT `resume`, rebuilding context from the stored history instead.
 */
export function isMissingResumeSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no conversation found with session/i.test(message);
}

export function isRetryableModelError(error: unknown): boolean {
  const status =
    isRecord(error) && typeof error.status === "number"
      ? error.status
      : undefined;
  if (status && RETRYABLE_MODEL_STATUS.has(status)) {
    return true;
  }
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return /overloaded|rate.?limit|too many requests|\b408\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|\b529\b|internal server error|service unavailable|bad gateway|gateway timeout|timed?\s?out|etimedout|econnreset|econnrefused|enotfound|socket hang up|fetch failed|connection error|network error|server_error|api_error/.test(
    message,
  );
}

/**
 * The ordered list of models to try for a run. Walks DOWN the tier order
 * (opus→sonnet→haiku) starting from the resolved model, so a transient failure
 * on the primary falls back to a lighter tier. A concrete (non-tier) primary —
 * e.g. an admin override pinned to a specific model id — is tried first, then
 * the lower tiers. Callers gate this on `modelFallback` + no env pin.
 */
export function buildModelFallbackChain(primary: string): string[] {
  const idx = MODEL_TIER_IDS.indexOf(primary);
  if (idx >= 0) {
    return MODEL_TIER_IDS.slice(idx);
  }
  return [primary, "sonnet", "haiku"].filter(
    (model, i, arr) => arr.indexOf(model) === i,
  );
}

/**
 * Run the Claude Agent SDK against the avatar's plugin roots.
 *
 * Permission model — enforced by a PreToolUse hook, NOT canUseTool/onUserDialog.
 * (Empirically, the SDK's interactive control callbacks `canUseTool`/`onUserDialog`
 * do NOT fire in this headless `query()` setup — verified against v0.3.169 — but
 * PreToolUse hooks DO fire and can block asynchronously, so the hook is our gate.)
 *
 *  - Read-only tools / knowledge MCP / orchestration meta-tools → allowed silently.
 *  - AskUserQuestion → intercepted: we surface the question, await the user's
 *    answer, and inject it back as the tool result (via a deny+reason, which the
 *    model reads as the answer).
 *  - Any other tool (Write/Edit/Bash/WebFetch/…):
 *      • OWNER  → interactive permission prompt (approve → allow, else deny).
 *      • COLLEAGUE → denied (read-only) and surfaced as a "blocked" notice.
 *
 * Streaming + interactivity are opt-in via the events sink.
 */
export async function runClaudeAgent(
  request: AgentRequest,
  pluginRoots: PluginRoot[],
  config: AppConfig,
  store: Store,
  events?: AgentEvents,
  abortController?: AbortController,
): Promise<AgentResponse> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: (input: unknown) => AsyncIterable<unknown>;
  };
  const { buildKnowledgeServer, KNOWLEDGE_SERVER_NAME, KNOWLEDGE_TOOL_NAMES } =
    await import("./knowledgeTools.js");
  const {
    buildRepoServer,
    REPO_SERVER_NAME,
    REPO_TOOL_NAMES,
    REPO_CREATE_TOOL_NAME,
  } = await import("./repoTools.js");
  const { buildSshTrustServer, SSH_TRUST_SERVER_NAME, SSH_TRUST_TOOL_NAMES } =
    await import("./sshTrustTools.js");
  const {
    buildSshIdentityServer,
    SSH_IDENTITY_SERVER_NAME,
    SSH_IDENTITY_TOOL_NAMES,
  } = await import("./sshIdentityTools.js");
  const { buildSystemServer, SYSTEM_SERVER_NAME, SYSTEM_TOOL_NAMES } =
    await import("./systemTools.js");
  const {
    buildConfluenceServer,
    CONFLUENCE_SERVER_NAME,
    CONFLUENCE_TOOL_NAMES,
  } = await import("./confluenceTools.js");
  const {
    buildAvatarDirectoryServer,
    AVATAR_DIRECTORY_SERVER_NAME,
    AVATAR_DIRECTORY_TOOL_NAMES,
  } = await import("./avatarDirectoryTools.js");
  const { buildGitRepoServer, GIT_REPO_SERVER_NAME, GIT_REPO_TOOL_NAMES } =
    await import("./gitRepoTools.js");
  const {
    buildGroupRepoServer,
    GROUP_REPO_SERVER_NAME,
    GROUP_REPO_TOOL_NAMES,
  } = await import("./groupRepoTools.js");
  const { buildCanvasServer, CANVAS_SERVER_NAME, CANVAS_TOOL_NAMES } =
    await import("./canvasTools.js");
  const { buildBrainServer, BRAIN_SERVER_NAME, BRAIN_TOOL_NAMES } =
    await import("./brainTools.js");
  const {
    buildGroupBrainServer,
    GROUP_BRAIN_SERVER_NAME,
    GROUP_BRAIN_TOOL_NAMES,
  } = await import("./groupBrainTools.js");

  const streaming = Boolean(events);
  // Tool-access derivation lives in deriveAgentToolAccess (a pure, unit-tested
  // helper): because the PreToolUse hook auto-allows every mcp__* tool, these
  // booleans are the real gate between a headless/colleague run and owner-only
  // tools, so the logic must be testable in isolation.
  const {
    viewerIsOwner,
    headless,
    allowHeadlessTools,
    ownerToolAccess,
    elevatedToolAccess,
    elevated,
    autoApprove,
    hexSshViewerClass,
  } = deriveAgentToolAccess(request);
  const hexSshPolicy = store.getHexSshToolPolicy();
  const hexSshAllowedTools = allowedHexSshToolsForViewer(
    hexSshPolicy,
    hexSshViewerClass,
  );
  const enabledMcpToolGroups = effectiveMcpToolGroups(request.mcpToolGroups);
  const mcpToolGroupEnabled = (id: (typeof enabledMcpToolGroups)[number]) =>
    enabledMcpToolGroups.includes(id);
  const personalKnowledgeToolsEnabled =
    mcpToolGroupEnabled("personal_knowledge");
  const groupKnowledgeToolsEnabled = mcpToolGroupEnabled("group_knowledge");
  const gitRepoToolsEnabled = mcpToolGroupEnabled("git_repo");
  const confluenceToolsEnabled = mcpToolGroupEnabled("confluence");
  const sshToolsEnabled = mcpToolGroupEnabled("ssh");
  const avatarDirectoryToolsEnabled = mcpToolGroupEnabled("avatars");
  const canvasToolsEnabled = mcpToolGroupEnabled("canvas");
  const systemToolsEnabled = mcpToolGroupEnabled("system");
  // Effective model: an env-pinned ANTHROPIC_MODEL wins (mirrors the API-key vs.
  // subscription rule) and is a HARD lock; otherwise the user's per-conversation
  // tier pick (a Claude alias, resolved to a concrete model by the operator's
  // ANTHROPIC_DEFAULT_*_MODEL env), otherwise the admin-selected override,
  // otherwise the DEFAULT tier (opus). Unknown tiers are ignored so a stale/garbage
  // value can never reach the SDK as a model id.
  const userModelTier = isModelTier(request.modelTier)
    ? request.modelTier
    : undefined;
  // User-chosen reasoning effort for this conversation. Unknown/unset → leave
  // `options.effort` off so the SDK applies its own default (`high`). Independent
  // of the model pin: effort still applies when ANTHROPIC_MODEL locks the model.
  const userEffort = isEffortLevel(request.effort) ? request.effort : undefined;
  const effectiveModel =
    config.anthropicModel ??
    userModelTier ??
    store.getModelOverride() ??
    DEFAULT_MODEL_TIER;
  // Model fallback chain (scheduled routines only — `request.modelFallback`): on a
  // transient model/server error, retry down the tier order from the resolved
  // model. An env-pinned ANTHROPIC_MODEL is a HARD lock, so it never falls back.
  // Otherwise the chain is just the single resolved model (chat behavior).
  const modelChain =
    request.modelFallback && !config.anthropicModel
      ? buildModelFallbackChain(effectiveModel)
      : [effectiveModel];
  const agentStart = Date.now();

  agentLogger.info(
    {
      avatarId: request.avatar.id,
      viewerUserId: request.viewerUserId,
      headless,
      allowHeadlessTools,
      elevated,
      autoApprove,
      hexSshViewerClass,
      hexSshAllowedToolCount: hexSshAllowedTools.length,
      enabledMcpToolGroups,
      model: effectiveModel,
    },
    "agent run started",
  );

  // Knowledge-backfill tools, bound to this conversation's avatar + viewer.
  // Generic headless runs stay at colleague-level access, while scheduled owner
  // routines can opt into owner-level tools through allowHeadlessTools.
  const knowledgeServer = buildKnowledgeServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: ownerToolAccess,
    askerUserId: request.viewerUserId ?? null,
    askerName: request.viewerName ?? null,
  });
  // Knowledge-repo management tools (list/read/write/scaffold/commit). OWNER-ONLY:
  // a colleague, a trusted user, or a generic headless run gets a refusal from
  // every tool. Scheduled owner routines use ownerToolAccess above. Registered
  // unconditionally — the per-handler `viewerIsOwner` gate is the safety boundary,
  // mirroring the knowledge server above. The owner identity for commits is
  // resolved from the avatar's own user row (viewer == owner here).
  const ownerRow = store.getUserById(request.avatar.id);
  // Owner identity for commits, resolved from the avatar's own user row (viewer
  // == owner here), shared by all owner-scoped MCP servers below.
  const owner: AgentOwner = {
    id: request.avatar.id,
    username: ownerRow?.username ?? "",
    displayName: ownerRow?.displayName ?? request.avatar.displayName,
    alias: ownerRow?.alias ?? request.avatar.alias,
  };
  // The avatar's live system self-state, read once from store+config (the same
  // facts the describe_system tool reports — see ownerState.ts). buildPrompt's
  // owner/routine self-state fields below are sourced from this so the two
  // call sites can't drift in WHAT they read.
  const ownerState = summarizeOwnerState(store, config, request.avatar.id);
  // Computed once and reused for the prompt (below). The repo-creation tool is
  // exposed ONLY for an owner-driven, non-headless chat with NO repo yet — once
  // one is connected, hiding it keeps the unused tool out of every prompt.
  const knowledgeRepoConfigured = ownerState.knowledgeRepoConfigured;
  const allowRepoCreate =
    personalKnowledgeToolsEnabled &&
    ownerToolAccess &&
    !knowledgeRepoConfigured;
  const repoServer = buildRepoServer(
    store,
    {
      avatarUserId: request.avatar.id,
      owner,
      viewerIsOwner: ownerToolAccess,
      // Trusted same-group teammates may READ (list_files/read_file) the owner's
      // personal repo; write/commit stay owner-only (see repoTools.ts).
      elevated: elevatedToolAccess,
      config,
    },
    { allowCreate: allowRepoCreate },
  );
  // Personal second brain (#second-brain): read-only `wiki/` recall over the
  // owner's knowledge repo. Always-on (no feature flag) — gated on a connected
  // repo + read access (owner OR trusted teammate, like `mcp__repo__read_file`).
  // The repo is resolved from the OWNER (avatar.id) inside the tools, never the
  // viewer, so a teammate's search hits the owner's vault. brainActive is the
  // SINGLE boolean used byte-identically in allowedTools + mcpServers below.
  const brainActive =
    personalKnowledgeToolsEnabled &&
    knowledgeRepoConfigured &&
    elevatedToolAccess;
  const brainServer = buildBrainServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: ownerToolAccess,
    elevated: elevatedToolAccess,
    config,
  });
  const systemServer = buildSystemServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
    config,
    selectedModelTier: userModelTier,
    selectedEffort: userEffort,
    enabledMcpToolGroups,
    // The working repo opened for this conversation (NAME only — the clone path is
    // never surfaced). Mirrors buildPrompt's activeRepoSection in describe_system.
    activeRepoName: request.activeRepoName,
  });
  // Cross-avatar discovery (read-only): lets the avatar look up OTHER visible
  // avatars by capability so it can point the user at a teammate avatar for
  // things outside its own expertise. Visibility is from the VIEWER's POV (the
  // person chatting), and the current avatar is excluded from its own results.
  const avatarDirectoryServer = buildAvatarDirectoryServer(store, {
    avatarUserId: request.avatar.id,
    viewerUserId: request.viewerUserId ?? request.avatar.id,
  });
  const sshIdentityServer = buildSshIdentityServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
  });
  const gitRepoServer = buildGitRepoServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
    elevated: elevatedToolAccess,
    config,
    conversationId: request.conversationId,
  });
  // Group knowledge-repo tools (per group the OWNER belongs to). OWNER-ONLY like
  // the personal repo tools — a group admin edits their group repo through their
  // own avatar; each tool then checks the owner's role in the named group (member
  // reads, admin writes). Registered only for an owner-driven turn where the
  // owner actually belongs to ≥1 group, to keep the tools out of other prompts.
  const ownerGroups = ownerState.groups;
  const groupRepoActive =
    groupKnowledgeToolsEnabled && ownerToolAccess && ownerGroups.length > 0;
  const groupRepoServer = buildGroupRepoServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
    config,
  });
  // Group (team) second brain: read-only `wiki/` recall over a group's shared
  // repo, scoped per-group to the OWNER's memberships inside the tools. Owner-only
  // at registration (like the group repo tools), active when the owner is in ≥1
  // group with a connected shared repo. groupBrainActive is the SINGLE boolean
  // used byte-identically in allowedTools + mcpServers below.
  const groupBrainActive =
    groupKnowledgeToolsEnabled &&
    ownerToolAccess &&
    ownerGroups.some((g) => g.knowledgeRepoConfigured);
  const groupBrainServer = buildGroupBrainServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: ownerToolAccess,
    config,
  });

  // Visual canvas (experimental `canvas` feature, #50): registered only when the
  // avatar OWNER enabled it AND this is an interactive turn with a canvas sink
  // (events.onCanvas). Gating on the owner's setting — not the viewer's — means
  // colleagues chatting with that avatar also get canvases (the feature grants no
  // elevation; the handler self-gates nothing because showing UI is harmless).
  const canvasActive =
    canvasToolsEnabled &&
    Boolean(events?.onCanvas) &&
    ownerState.experimentalFeatures.includes("canvas");
  const canvasServer = canvasActive
    ? buildCanvasServer({ emitCanvas: events!.onCanvas! })
    : null;

  // SSH host-trust tools (add/list/remove the hosts hex-ssh will connect to).
  // NOT owner-only: host fingerprints are public, and a viewer who can drive
  // hex-ssh can manage its trust. The trust file is keyed to the owner
  // (avatar.id) and injected into hex-ssh below as KNOWN_HOSTS_PATH.
  const sshTrustServer = buildSshTrustServer({
    avatarUserId: request.avatar.id,
    config,
  });

  // The avatar acts on its OWNER's behalf, so it uses the OWNER's secrets
  // (avatar.id) regardless of who is chatting — a colleague talking to the
  // owner's avatar still operates with the owner's credentials. The values are
  // decrypted only here and handed to the MCP subprocess as env, so they never
  // surface to the agent (Bash/`env` runs in a different process) nor to `toUser`.
  const ownerSecrets = store.getUserSecrets(request.avatar.id);
  const sshSecrets = sshMcpSecretEnv(ownerSecrets);
  const confluenceServer = buildConfluenceServer({
    config,
    ownerSecrets,
    elevated: elevatedToolAccess,
  });
  // hex-ssh (remote-server access MCP, ssh2-based — no system ssh binary needed):
  // registered explicitly (not via a plugin's .mcp.json) so we can inject the
  // owner's per-user SSH identity. The policy proxy filters tools/list before
  // the model sees it, and the PreToolUse hook below enforces the same allowlist
  // again on tools/call.
  const hexSshProxyPath = path.join(
    process.cwd(),
    "scripts",
    "hex-ssh-policy-proxy.mjs",
  );
  const sshActive =
    sshToolsEnabled &&
    Boolean(ownerSecrets.SSH_PRIVATE_KEY && hexSshAllowedTools.length > 0);
  const sshServers = sshActive
    ? {
        [HEX_SSH_SERVER_NAME]: {
          type: "stdio" as const,
          command: process.execPath,
          args: [hexSshProxyPath],
          // KNOWN_HOSTS_PATH points hex-ssh at the owner's persistent trust file
          // (under the data volume). hex-ssh re-reads it on every connection, so
          // the `mcp__ssh_trust__*` tools can add a host mid-session and it takes
          // effect immediately. Only SSH-specific secrets are forwarded here:
          // git credentials stay inside the app-managed git MCP handlers.
          env: {
            REMOTE_SSH_MODE: "safe",
            KNOWN_HOSTS_PATH: knownHostsPath(request.avatar.id, config),
            ...sshSecrets,
            HEX_SSH_UPSTREAM_COMMAND: config.hexSshCommand,
            HEX_SSH_ALLOWED_TOOLS: hexSshAllowedTools.join(","),
          },
        },
      }
    : {};

  const options: Record<string, unknown> = {
    plugins: pluginRoots,
    // The PreToolUse hook (below) is the real gate. `default` mode is required —
    // it's the mode in which the hook's deny decision is honored.
    permissionMode: "default",
    // Auto-approve (no prompt) the read-only + knowledge + meta tools. NOTE: this
    // is only an auto-approve list, NOT a restriction — the hook does enforcement.
    allowedTools: [
      ...config.readOnlyTools,
      ...(personalKnowledgeToolsEnabled ? KNOWLEDGE_TOOL_NAMES : []),
      ...(personalKnowledgeToolsEnabled ? REPO_TOOL_NAMES : []),
      ...(allowRepoCreate ? [REPO_CREATE_TOOL_NAME] : []),
      ...(systemToolsEnabled ? SYSTEM_TOOL_NAMES : []),
      ...(confluenceToolsEnabled ? CONFLUENCE_TOOL_NAMES : []),
      ...(avatarDirectoryToolsEnabled ? AVATAR_DIRECTORY_TOOL_NAMES : []),
      ...(sshToolsEnabled ? SSH_IDENTITY_TOOL_NAMES : []),
      ...(gitRepoToolsEnabled ? GIT_REPO_TOOL_NAMES : []),
      ...(groupRepoActive ? GROUP_REPO_TOOL_NAMES : []),
      ...(brainActive ? BRAIN_TOOL_NAMES : []),
      ...(groupBrainActive ? GROUP_BRAIN_TOOL_NAMES : []),
      ...(canvasActive ? CANVAS_TOOL_NAMES : []),
      ...(sshActive ? SSH_TRUST_TOOL_NAMES : []),
      "Skill",
      "TodoWrite",
      ...TASK_ORCHESTRATION_TOOLS,
    ],
    // Enable bundled + plugin skills (also auto-allows the `Skill` tool).
    skills: "all",
    // Register the SSH host-trust server alongside hex-ssh, and only when hex-ssh
    // itself is active (the owner stored a key) — trust management is pointless
    // without a server to connect.
    mcpServers: {
      ...(personalKnowledgeToolsEnabled
        ? { [KNOWLEDGE_SERVER_NAME]: knowledgeServer }
        : {}),
      ...(personalKnowledgeToolsEnabled
        ? { [REPO_SERVER_NAME]: repoServer }
        : {}),
      ...(systemToolsEnabled ? { [SYSTEM_SERVER_NAME]: systemServer } : {}),
      ...(confluenceToolsEnabled
        ? { [CONFLUENCE_SERVER_NAME]: confluenceServer }
        : {}),
      ...(avatarDirectoryToolsEnabled
        ? { [AVATAR_DIRECTORY_SERVER_NAME]: avatarDirectoryServer }
        : {}),
      ...(sshToolsEnabled
        ? { [SSH_IDENTITY_SERVER_NAME]: sshIdentityServer }
        : {}),
      ...(gitRepoToolsEnabled ? { [GIT_REPO_SERVER_NAME]: gitRepoServer } : {}),
      ...(groupRepoActive ? { [GROUP_REPO_SERVER_NAME]: groupRepoServer } : {}),
      ...(brainActive ? { [BRAIN_SERVER_NAME]: brainServer } : {}),
      ...(groupBrainActive
        ? { [GROUP_BRAIN_SERVER_NAME]: groupBrainServer }
        : {}),
      ...(canvasServer ? { [CANVAS_SERVER_NAME]: canvasServer } : {}),
      ...sshServers,
      ...(sshActive ? { [SSH_TRUST_SERVER_NAME]: sshTrustServer } : {}),
    },
    maxTurns: config.maxTurns,
    // Isolation mode: load NO filesystem settings, so we never leak the operator's
    // machine config (MCP servers, enabled plugins, env, CLAUDE.md) into a chat.
    settingSources: [],
  };
  // Persist session transcripts under dataDir (not the SDK's default ~/.claude)
  // so a conversation's session can be resumed after a server/container restart.
  // `env` REPLACES the subprocess environment. Start from process.env for SDK
  // auth/proxy settings, but strip git credentials: git auth is only available
  // through the app-managed in-process MCP bridge.
  fs.mkdirSync(config.agentSessionsDir, { recursive: true });
  options.env = agentSubprocessEnv(process.env, config.agentSessionsDir);
  // Subscription auth: when no ANTHROPIC_API_KEY is configured, fall back to the
  // admin-pasted `claude setup-token` token (stored encrypted in app_config),
  // injecting it as CLAUDE_CODE_OAUTH_TOKEN. Precedence is API key (.env) > stored
  // subscription token, matching the authMode reported by /api/admin/system. The
  // token is decrypted only here into the subprocess env — never exposed to the
  // agent (Bash/`env` run in a separate process), same as the secret vault. We
  // also drop any empty ANTHROPIC_API_KEY left over from `.env` so it can't shadow
  // the OAuth token.
  if (!config.anthropicApiKey) {
    const oauthToken = store.getAppSecret(CLAUDE_OAUTH_TOKEN_KEY);
    if (oauthToken) {
      delete (options.env as Record<string, string | undefined>)
        .ANTHROPIC_API_KEY;
      (
        options.env as Record<string, string | undefined>
      ).CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
  }
  // Resume the conversation's prior session so the model keeps its context.
  if (request.resumeSessionId) {
    options.resume = request.resumeSessionId;
  }
  // Pin the model when configured (env or admin override); otherwise the SDK default.
  if (effectiveModel) {
    options.model = effectiveModel;
  }
  // Apply the user's reasoning effort when they picked one; otherwise omit it so
  // the SDK uses its default. The SDK downgrades unsupported levels per model.
  if (userEffort) {
    options.effort = userEffort;
  }
  if (streaming) {
    options.includePartialMessages = true;
  }
  if (abortController) {
    options.abortController = abortController;
  }
  // Confine the run to this session's workspace + the avatar's plugin dirs.
  if (request.cwd) {
    options.cwd = request.cwd;
  }
  // Plugin roots are always exposed as additional readable/writable dirs; an
  // active repo workspace (#47) also adds the per-conversation scratch dir here
  // (its clone became the cwd, so the scratch must stay reachable).
  const additionalDirectories = [
    ...pluginRoots.map((root) => root.path),
    ...(request.additionalDirs ?? []),
  ];
  if (additionalDirectories.length > 0) {
    options.additionalDirectories = additionalDirectories;
  }

  // PreToolUse hook: enforcement + interactivity. Runs in-process, so it can call
  // straight into the events sink and await the user.
  if (events) {
    options.hooks = {
      PreToolUse: [
        {
          hooks: [
            buildPreToolUseHook(
              events,
              elevated,
              config.readOnlyTools,
              headless,
              allowHeadlessTools,
              autoApprove,
              hexSshViewerClass,
              hexSshPolicy,
              config.rtkCommand,
              // Active repo workspace (#47): block remote/branch/destructive Bash
              // git so sync/push stay app-managed; local add/commit is allowed.
              Boolean(request.activeRepoName),
            ),
          ],
        },
      ],
    };
  }

  if (events) {
    events.onStatus?.("응답 생성 중…");
  }

  let state = createLoopState();
  let assistantChunks: string[] = [];
  let deltaChunks: string[] = [];
  let resultText = "";
  let resultErrorSubtype = "";
  let runUsage: AgentUsage | undefined;
  // Snapshot of the latest main-agent prompt size (≈ live context occupancy),
  // used to override the result usage's CUMULATIVE inputTokens for the badge.
  let contextTokens: number | undefined;
  let usedModel = effectiveModel;

  // Owner self-state (secret names, group memberships) flows to every
  // OWNER-DRIVEN turn: interactive owner chats AND owner-scheduled routines
  // (ownerToolAccess) — the same gate that registers the owner-level tools, so
  // prompt awareness and tool availability never diverge. Restricted headless
  // runs (intro/hashtag generation) and colleague/trusted chats keep them empty.
  const promptRequest: AgentRequest = {
    ...request,
    secretNames: ownerToolAccess ? ownerState.secretNames : [],
    knowledgeRepoConfigured,
    gitTokenSet: ownerState.gitTokenSet,
    githubHost: config.githubHost,
    confluenceUrlConfigured: Boolean(config.confluenceUrl),
    confluencePatConfigured: Boolean(
      ownerSecrets.CONFLUENCE_PAT ||
      ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN,
    ),
    groupMemberships: ownerToolAccess ? ownerGroups : [],
    mcpToolGroups: enabledMcpToolGroups,
    // Canvas standing guidance fires for ALL viewer classes of a canvas-enabled
    // turn (colleagues see canvases too). Experimental-feature self-state is
    // owner-driven only (META-COGNITION), matching describe_system's gating.
    canvasEnabled: canvasActive,
    experimentalFeatures: ownerToolAccess
      ? ownerState.experimentalFeatures
      : [],
  };

  // The prompt is normally a plain string. When the turn carries image
  // attachments we instead pass a single-message async-iterable ("streaming
  // input" mode) whose content is the prompt text + image blocks — the only way
  // to feed the model images. All `options` (resume/hooks/mcpServers/model) work
  // identically in both modes, so text-only turns keep the unchanged string path.
  let promptText = buildPrompt(promptRequest);

  // One-shot guard for the stale-resume self-heal below: if the SDK can't find
  // the session we asked it to resume, we drop `resume`, rebuild the prompt with
  // the stored history, and retry the SAME model once. This fires BEFORE any
  // assistant text streams (resume loads at query start), so it's safe even for
  // a live chat — nothing the viewer saw gets discarded.
  let resumeFallbackTried = false;

  // One-shot guard for the empty-turn self-heal below: occasionally the model
  // ends a turn with ONLY a thinking block (stopReason end_turn, no `text`
  // block, no tool call) and the SDK reports a `success` result with an empty
  // string, so the bubble would otherwise show the bare "응답이 비어 있습니다"
  // fallback. We re-run the SAME model once with a nudge to actually emit a text
  // answer. No ANSWER text streamed (producedText is false), so nothing the
  // viewer reads as the reply is discarded — but the failed attempt's reasoning
  // DID stream to the thinking view, so the retry fires onThinkingReset to drop
  // it (otherwise the kept turn's reasoning would render glued to the throwaway).
  let emptyTurnRetryTried = false;

  // Run the SDK query, walking the model fallback chain (single-element unless a
  // routine opted in). A retry re-runs from scratch on a fresh attempt, so it is
  // only safe for headless routines (no live stream consuming partial output);
  // chat always has a single-element chain.
  for (let attempt = 0; attempt < modelChain.length; attempt += 1) {
    const model = modelChain[attempt];
    if (model) {
      options.model = model;
      usedModel = model;
    }
    // Reset per-attempt accumulators so a retry never inherits a failed
    // attempt's partial text / usage.
    state = createLoopState();
    assistantChunks = [];
    deltaChunks = [];
    resultText = "";
    resultErrorSubtype = "";
    runUsage = undefined;
    contextTokens = undefined;
    // Build the prompt fresh each attempt: the image path is a single-use async
    // generator, so a retry needs a new one (the string path is reused as-is).
    const queryPrompt =
      request.images && request.images.length > 0
        ? buildImageQueryPrompt(promptText, request.images)
        : promptText;

    try {
      for await (const message of sdk.query({ prompt: queryPrompt, options })) {
        if (!isRecord(message)) {
          continue;
        }
        // Opt-in (AGENT_TOOL_TRACE) lifecycle trace of every raw SDK message, in
        // order — pinpoints where a tool-calling run stalls (e.g. vLLM opens a
        // tool_use block that never closes). No-op unless the flag is set.
        traceSdkMessage(message);
        if (events) {
          if (message.type === "stream_event") {
            const delta = handleStreamEvent(message, events);
            if (delta) {
              deltaChunks.push(delta);
            }
            // Capture the context-occupancy snapshot HERE: while streaming, the
            // prompt-size counts live on the message_start event, not on the
            // final assistant message's usage (which carries only output). The
            // last main-agent message_start of the turn = final request's size.
            const startCtx = streamStartContextTokens(message);
            if (startCtx !== undefined) {
              contextTokens = startCtx;
            }
            continue;
          }
          if (message.type === "system") {
            handleSystemEvent(message, events, state);
            continue;
          }
          if (message.type === "user") {
            handleUserMessage(message, events, state);
            continue;
          }
          if (message.type === "tool_progress") {
            const toolName =
              asString(message.tool_name) || asString(message.toolName);
            events.onStatus?.(toolName ? `실행 중: ${toolName}` : "실행 중…");
            continue;
          }
        }

        if (message.type === "assistant") {
          // With an events sink this also emits tool/agent start events.
          const assistantText = events
            ? handleAssistantMessage(message, events, state)
            : extractMainAssistantText(message);
          if (assistantText) {
            assistantChunks.push(assistantText);
          }
          // Track the final main-agent prompt size as the context-occupancy
          // snapshot (overrides the cumulative result usage below).
          const ctxTokens = mainAssistantContextTokens(message);
          if (ctxTokens !== undefined) {
            contextTokens = ctxTokens;
          }
          continue;
        }

        const {
          text: extractedResult,
          errorSubtype,
          usage,
        } = interpretResult(message);
        if (extractedResult) {
          resultText = extractedResult;
        }
        if (errorSubtype) {
          resultErrorSubtype = errorSubtype;
        }
        if (usage) {
          runUsage = usage;
        }
      }
      // Attempt finished (success or an in-band error result, e.g. max_turns) —
      // those are not transient model-server failures, so don't fall back.
      //
      // Empty-turn self-heal: a `success` result that yielded NO text anywhere
      // (no streamed/assistant text, no result string) and carried NO error
      // subtype means the model ended on a thinking-only turn. Re-run the SAME
      // model once with a nudge to emit a visible answer; mirrors the resume
      // self-heal (re-run, don't consume a fallback step). Skip if aborted or
      // already retried — then fall through to the empty-text fallback below.
      const producedText = Boolean(
        assistantChunks.join("").trim() ||
          deltaChunks.join("").trim() ||
          resultText.trim(),
      );
      if (
        !producedText &&
        !resultErrorSubtype &&
        !emptyTurnRetryTried &&
        !abortController?.signal.aborted
      ) {
        emptyTurnRetryTried = true;
        promptText = `${promptText}\n\n${EMPTY_TURN_RETRY_NUDGE}`;
        agentLogger.warn(
          {
            avatarId: request.avatar.id,
            conversationId: request.conversationId,
            model,
          },
          "empty turn (thinking-only); retrying once with a text-answer nudge",
        );
        // Drop the throwaway attempt's streamed reasoning so the kept turn's
        // thinking doesn't render concatenated onto it (the chat-route/client
        // thinking accumulators live outside this loop and never reset on retry).
        events?.onThinkingReset?.();
        events?.onStatus?.("응답을 다시 생성하는 중…");
        attempt -= 1; // re-run the SAME model (don't consume a fallback step)
        continue;
      }
      break;
    } catch (error) {
      // Self-heal a stale/missing resume target: re-run this same attempt with
      // `resume` dropped so the stored history (now injected by buildPrompt once
      // resumeSessionId is unset) rebuilds the context. The viewer never sees the
      // error. On success the run reports a FRESH session id, which the chat route
      // persists in place of the dangling one — so the next turn resumes cleanly.
      if (
        !resumeFallbackTried &&
        options.resume &&
        !abortController?.signal.aborted &&
        isMissingResumeSessionError(error)
      ) {
        resumeFallbackTried = true;
        delete options.resume;
        promptRequest.resumeSessionId = undefined;
        promptText = buildPrompt(promptRequest);
        agentLogger.warn(
          {
            avatarId: request.avatar.id,
            conversationId: request.conversationId,
          },
          "resume session missing; retrying with stored history",
        );
        attempt -= 1; // re-run the SAME model (don't consume a fallback step)
        continue;
      }
      const nextModel = modelChain[attempt + 1];
      const canFallback =
        Boolean(nextModel) &&
        !abortController?.signal.aborted &&
        isRetryableModelError(error);
      if (!canFallback) {
        throw error;
      }
      agentLogger.warn(
        {
          avatarId: request.avatar.id,
          from: model,
          to: nextModel,
          detail: error instanceof Error ? error.message : String(error),
        },
        "model fallback after transient error",
      );
      // No live viewer on a routine, but keep the channel consistent.
      events?.onStatus?.(`모델을 ${nextModel}(으)로 전환해 다시 시도합니다…`);
    }
  }

  // Prefer the full text the model actually STREAMED (every main-agent assistant
  // text block / delta across ALL turns) over the SDK's terminal `result` string,
  // which is only the LAST assistant turn's text. The streamed transcript is what
  // the user watched appear live; finalizing/persisting from `resultText` instead
  // dropped any narration emitted before the final turn (preambles, text between
  // tool calls) the instant the run completed — and kept it gone on reload, since
  // this value is what gets stored. resultText is only a fallback for the rare
  // case nothing streamed; the error fallback applies when neither produced text.
  // The result usage's inputTokens is cumulative across all of the turn's model
  // requests, so dividing it by the context window made the badge's % balloon
  // past 100% on tool-heavy turns. Swap in the final request's prompt size — a
  // true context-occupancy snapshot — while keeping outputTokens cumulative
  // (total generated this turn). finalizeTurnUsage also corrects contextWindow
  // (the SDK reports a stale 200K base for Opus 4.8's real 1M) and — crucially —
  // handles the no-snapshot turn: when contextTokens is undefined (error_max_turns
  // result, or subagent-only assistant messages) it does NOT divide the cumulative
  // inputTokens by the window (a meaningless ratio that ballooned past 100%); it
  // zeroes the context numbers so the badge shows output-only instead.
  if (runUsage) {
    runUsage = finalizeTurnUsage(runUsage, contextTokens);
  }

  const partialText =
    assistantChunks.join("\n\n").trim() || deltaChunks.join("").trim();
  const text =
    partialText ||
    resultText ||
    (resultErrorSubtype
      ? resultErrorMessage(resultErrorSubtype)
      : "Claude Agent SDK 응답이 비어 있습니다.");
  agentLogger.info(
    {
      avatarId: request.avatar.id,
      runtime: "claude",
      model: usedModel,
      modelFellBack: usedModel !== effectiveModel,
      textLength: text.length,
      durationMs: Date.now() - agentStart,
    },
    "agent run completed",
  );
  return {
    kind: "text",
    runtime: "claude",
    summary: "Claude Agent SDK 실행이 완료되었습니다.",
    text,
    ...(runUsage ? { usage: runUsage } : {}),
  };
}
