import fs from "node:fs";
import path from "node:path";
import type { AppConfig, AgentRequest, AgentResponse, AgentUsage, AgentOwner, PluginRoot } from "../types.js";
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
import { isModelTier, DEFAULT_MODEL_TIER } from "../modelTiers.js";
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
  resultErrorMessage,
} from "./sdkMessageHandlers.js";

// Re-export the symbols moved into sibling modules so existing import paths
// (app.ts, index.ts, tests/units.test.ts, infra/agent-core/… tests) keep
// resolving against this module unchanged.
export { buildPrompt } from "./promptBuilder.js";
export { buildPreToolUseHook, rewriteBashCommandWithRtk } from "./preToolUseHook.js";
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

export function sshMcpSecretEnv(ownerSecrets: Record<string, string>): Record<string, string> {
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
  /** Owner OR trusted, IGNORING headless — gates the auto-approve path + greeting. */
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
  const elevatedToolAccess = (viewerIsOwner || Boolean(request.elevated)) && !headlessRestricted;
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
  const { buildKnowledgeServer, KNOWLEDGE_SERVER_NAME, KNOWLEDGE_TOOL_NAMES } = await import(
    "./knowledgeTools.js"
  );
  const { buildRepoServer, REPO_SERVER_NAME, REPO_TOOL_NAMES, REPO_CREATE_TOOL_NAME } = await import(
    "./repoTools.js"
  );
  const { buildSshTrustServer, SSH_TRUST_SERVER_NAME, SSH_TRUST_TOOL_NAMES } = await import(
    "./sshTrustTools.js"
  );
  const { buildSshIdentityServer, SSH_IDENTITY_SERVER_NAME, SSH_IDENTITY_TOOL_NAMES } = await import(
    "./sshIdentityTools.js"
  );
  const { buildSystemServer, SYSTEM_SERVER_NAME, SYSTEM_TOOL_NAMES } = await import(
    "./systemTools.js"
  );
  const { buildConfluenceServer, CONFLUENCE_SERVER_NAME, CONFLUENCE_TOOL_NAMES } = await import(
    "./confluenceTools.js"
  );
  const { buildAvatarDirectoryServer, AVATAR_DIRECTORY_SERVER_NAME, AVATAR_DIRECTORY_TOOL_NAMES } =
    await import("./avatarDirectoryTools.js");
  const { buildGitRepoServer, GIT_REPO_SERVER_NAME, GIT_REPO_TOOL_NAMES } = await import(
    "./gitRepoTools.js"
  );
  const { buildGroupRepoServer, GROUP_REPO_SERVER_NAME, GROUP_REPO_TOOL_NAMES } = await import(
    "./groupRepoTools.js"
  );
  const { buildCanvasServer, CANVAS_SERVER_NAME, CANVAS_TOOL_NAMES } = await import("./canvasTools.js");

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
  const hexSshAllowedTools = allowedHexSshToolsForViewer(hexSshPolicy, hexSshViewerClass);
  // Effective model: an env-pinned ANTHROPIC_MODEL wins (mirrors the API-key vs.
  // subscription rule) and is a HARD lock; otherwise the user's per-conversation
  // tier pick (a Claude alias, resolved to a concrete model by the operator's
  // ANTHROPIC_DEFAULT_*_MODEL env), otherwise the admin-selected override,
  // otherwise the DEFAULT tier (opus). Unknown tiers are ignored so a stale/garbage
  // value can never reach the SDK as a model id.
  const userModelTier = isModelTier(request.modelTier) ? request.modelTier : undefined;
  const effectiveModel =
    config.anthropicModel ?? userModelTier ?? store.getModelOverride() ?? DEFAULT_MODEL_TIER;
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
  // Only needed for the owner's opening greeting — every other turn stays quiet.
  const openRequestCount =
    request.greeting && viewerIsOwner && !headless
      ? store.countOpenKnowledgeRequests(request.avatar.id)
      : 0;

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
  const allowRepoCreate = ownerToolAccess && !knowledgeRepoConfigured;
  const repoServer = buildRepoServer(
    store,
    {
      avatarUserId: request.avatar.id,
      owner,
      viewerIsOwner: ownerToolAccess,
      config,
    },
    { allowCreate: allowRepoCreate },
  );
  const systemServer = buildSystemServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
    config,
    selectedModelTier: userModelTier,
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
  });
  // Group knowledge-repo tools (per group the OWNER belongs to). OWNER-ONLY like
  // the personal repo tools — a group admin edits their group repo through their
  // own avatar; each tool then checks the owner's role in the named group (member
  // reads, admin writes). Registered only for an owner-driven turn where the
  // owner actually belongs to ≥1 group, to keep the tools out of other prompts.
  const ownerGroups = ownerState.groups;
  const groupRepoActive = ownerToolAccess && ownerGroups.length > 0;
  const groupRepoServer = buildGroupRepoServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
    config,
  });

  // Visual canvas (experimental `canvas` feature, #50): registered only when the
  // avatar OWNER enabled it AND this is an interactive turn with a canvas sink
  // (events.onCanvas). Gating on the owner's setting — not the viewer's — means
  // colleagues chatting with that avatar also get canvases (the feature grants no
  // elevation; the handler self-gates nothing because showing UI is harmless).
  const canvasActive = Boolean(events?.onCanvas) && ownerState.experimentalFeatures.includes("canvas");
  const canvasServer = canvasActive ? buildCanvasServer({ emitCanvas: events!.onCanvas! }) : null;

  // SSH host-trust tools (add/list/remove the hosts hex-ssh will connect to).
  // NOT owner-only: host fingerprints are public, and a viewer who can drive
  // hex-ssh can manage its trust. The trust file is keyed to the owner
  // (avatar.id) and injected into hex-ssh below as KNOWN_HOSTS_PATH.
  const sshTrustServer = buildSshTrustServer({ avatarUserId: request.avatar.id, config });

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
  const hexSshProxyPath = path.join(process.cwd(), "scripts", "hex-ssh-policy-proxy.mjs");
  const sshActive = Boolean(ownerSecrets.SSH_PRIVATE_KEY && hexSshAllowedTools.length > 0);
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
      ...KNOWLEDGE_TOOL_NAMES,
      ...REPO_TOOL_NAMES,
      ...(allowRepoCreate ? [REPO_CREATE_TOOL_NAME] : []),
      ...SYSTEM_TOOL_NAMES,
      ...CONFLUENCE_TOOL_NAMES,
      ...AVATAR_DIRECTORY_TOOL_NAMES,
      ...SSH_IDENTITY_TOOL_NAMES,
      ...GIT_REPO_TOOL_NAMES,
      ...(groupRepoActive ? GROUP_REPO_TOOL_NAMES : []),
      ...(canvasActive ? CANVAS_TOOL_NAMES : []),
      ...SSH_TRUST_TOOL_NAMES,
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
      [KNOWLEDGE_SERVER_NAME]: knowledgeServer,
      [REPO_SERVER_NAME]: repoServer,
      [SYSTEM_SERVER_NAME]: systemServer,
      [CONFLUENCE_SERVER_NAME]: confluenceServer,
      [AVATAR_DIRECTORY_SERVER_NAME]: avatarDirectoryServer,
      [SSH_IDENTITY_SERVER_NAME]: sshIdentityServer,
      [GIT_REPO_SERVER_NAME]: gitRepoServer,
      ...(groupRepoActive ? { [GROUP_REPO_SERVER_NAME]: groupRepoServer } : {}),
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
      delete (options.env as Record<string, string | undefined>).ANTHROPIC_API_KEY;
      (options.env as Record<string, string | undefined>).CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
  }
  // Resume the conversation's prior session so the model keeps its context. Only
  // a real follow-up turn passes one (greeting/regenerate start fresh — see app.ts).
  if (request.resumeSessionId) {
    options.resume = request.resumeSessionId;
  }
  // Pin the model when configured (env or admin override); otherwise the SDK default.
  if (effectiveModel) {
    options.model = effectiveModel;
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
              // Active repo workspace (#47): block state-changing/remote Bash git
              // (integrity guard, not security) so the avatar uses mcp__git_repo__*.
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

  const state = createLoopState();
  const assistantChunks: string[] = [];
  const deltaChunks: string[] = [];
  let resultText = "";
  let resultErrorSubtype = "";
  let runUsage: AgentUsage | undefined;

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
    confluencePatConfigured: Boolean(ownerSecrets.CONFLUENCE_PAT || ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN),
    groupMemberships: ownerToolAccess ? ownerGroups : [],
    // Canvas standing guidance fires for ALL viewer classes of a canvas-enabled
    // turn (colleagues see canvases too). Experimental-feature self-state is
    // owner-driven only (META-COGNITION), matching describe_system's gating.
    canvasEnabled: canvasActive,
    experimentalFeatures: ownerToolAccess ? ownerState.experimentalFeatures : [],
  };

  for await (const message of sdk.query({ prompt: buildPrompt(promptRequest, openRequestCount), options })) {
    if (!isRecord(message)) {
      continue;
    }
    if (events) {
      if (message.type === "stream_event") {
        const delta = handleStreamEvent(message, events);
        if (delta) {
          deltaChunks.push(delta);
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
        const toolName = asString(message.tool_name) || asString(message.toolName);
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
      continue;
    }

    const { text: extractedResult, errorSubtype, usage } = interpretResult(message);
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

  // Prefer the full text the model actually STREAMED (every main-agent assistant
  // text block / delta across ALL turns) over the SDK's terminal `result` string,
  // which is only the LAST assistant turn's text. The streamed transcript is what
  // the user watched appear live; finalizing/persisting from `resultText` instead
  // dropped any narration emitted before the final turn (preambles, text between
  // tool calls) the instant the run completed — and kept it gone on reload, since
  // this value is what gets stored. resultText is only a fallback for the rare
  // case nothing streamed; the error fallback applies when neither produced text.
  const partialText = assistantChunks.join("\n\n").trim() || deltaChunks.join("").trim();
  const text =
    partialText ||
    resultText ||
    (resultErrorSubtype
      ? resultErrorMessage(resultErrorSubtype)
      : "Claude Agent SDK 응답이 비어 있습니다.");
  agentLogger.info(
    { avatarId: request.avatar.id, runtime: "claude", textLength: text.length, durationMs: Date.now() - agentStart },
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
