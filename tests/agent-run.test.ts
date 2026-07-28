import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type {
  AgentEvents,
} from "../src/server/agent/events.js";
import type { AgentRequest, AppConfig } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// Partially mock the Claude Agent SDK: keep tool()/createSdkMcpServer() and
// everything else REAL (the in-process MCP servers build against them at
// registration time), replacing only `query` with a per-test scriptable fake.
// The fake records a SNAPSHOT of each call's `options` — the real run loop
// mutates the single `options` object in place across attempts (resume/model),
// so a live reference would read the post-mutation state.
// ---------------------------------------------------------------------------
type QueryArgs = { prompt: unknown; options: Record<string, unknown> };
type QueryHandle = AsyncIterable<unknown> & {
  getContextUsage?: () => Promise<{ totalTokens?: number; maxTokens?: number } | undefined>;
};

const sdkMock = vi.hoisted(() => ({
  impl: null as null | ((args: QueryArgs) => QueryHandle),
  calls: [] as { prompt: unknown; options: Record<string, unknown> }[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: (args: QueryArgs) => {
      sdkMock.calls.push({ prompt: args.prompt, options: { ...args.options } });
      if (!sdkMock.impl) {
        throw new Error("sdkMock.impl not programmed for this test");
      }
      return sdkMock.impl(args);
    },
  };
});

import { createServices } from "../src/server/app.js";
import { CLAUDE_OAUTH_TOKEN_KEY } from "../src/server/store.js";
import { runAgentStream } from "../src/server/agent/index.js";
import {
  buildImageQueryPrompt,
  runClaudeAgent,
  resultErrorMessage,
} from "../src/server/agent/claudeAgent.js";
import { DEFAULT_MODEL_TIER } from "../src/server/modelTiers.js";
import {
  attachRunClient,
  awaitResponse,
  cancelAllRuns,
  cancelRun,
  CANCELLED,
  closeRun,
  emitRunEvent,
  getActiveRun,
  getActiveRunForConversation,
  isRunCancelled,
  openRun,
  submitResponse,
} from "../src/server/agent/runRegistry.js";

// ---------------------------------------------------------------------------
// SDK-message + query-handle builders (shapes copied from sdkMessageHandlers /
// agent-core fixtures).
// ---------------------------------------------------------------------------
const initMsg = (sessionId = "sess-1", model = "opus") => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model,
});
const startMsg = (usage: Record<string, number>) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "message_start", message: { usage } },
});
const deltaMsg = (text: string) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const thinkingMsg = (thinking: string) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
});
const textBlock = (text: string) => ({ type: "text", text });
const toolUseBlock = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const assistantMsg = (content: unknown[], usage?: Record<string, number>) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content, ...(usage ? { usage } : {}) },
});
const toolResultMsg = (toolUseId: string, isError = false) => ({
  type: "user",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
});
const successResult = (result: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  result,
  ...extra,
});

/** A query handle that yields a fixed message list, optionally with a getContextUsage control method. */
function handleFrom(
  messages: unknown[],
  opts: { getContextUsage?: QueryHandle["getContextUsage"] } = {},
): QueryHandle {
  async function* gen() {
    for (const message of messages) {
      yield message;
    }
  }
  const handle = gen() as QueryHandle;
  if (opts.getContextUsage) {
    handle.getContextUsage = opts.getContextUsage;
  }
  return handle;
}

/** A query handle that throws on iteration (optionally aborting a controller first). */
function throwingHandle(error: unknown, opts: { abort?: AbortController } = {}): QueryHandle {
  async function* gen() {
    if (opts.abort) {
      opts.abort.abort();
    }
    throw error;
  }
  return gen() as QueryHandle;
}

/** Events sink of vi.fn spies; pass overrides to add optional callbacks (e.g. onCanvas). */
function makeEvents(overrides: Partial<AgentEvents> = {}): AgentEvents {
  return {
    onDelta: vi.fn(),
    onThinking: vi.fn(),
    onThinkingReset: vi.fn(),
    onStatus: vi.fn(),
    onModel: vi.fn(),
    onSessionId: vi.fn(),
    onPlugin: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onTaskStart: vi.fn(),
    onTaskUpdate: vi.fn(),
    onTaskEnd: vi.fn(),
    onAgentStart: vi.fn(),
    onAgentEnd: vi.fn(),
    onBlocked: vi.fn(),
    onPlan: vi.fn(),
    ...overrides,
  };
}

let tempDir: string;
const getTempDir = withTempDir("agent-run", () => {
  tempDir = getTempDir();
  sdkMock.calls.length = 0;
  sdkMock.impl = null;
});

/** Fresh services + an owner user + a realistic owner AgentRequest, over the per-test temp dir. */
function setup(configOverrides: Partial<AppConfig> = {}) {
  const { config, store } = createServices({
    dataDir: tempDir,
    agentRuntime: "claude",
    sessionSecret: "test",
    // Neutralize any ANTHROPIC_MODEL/API key from the dev machine's env so model
    // resolution is deterministic (env pin would otherwise win over the tier).
    anthropicModel: undefined,
    anthropicApiKey: undefined,
    ...configOverrides,
  });
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const cwd = path.join(tempDir, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  const baseRequest: AgentRequest = {
    message: "안녕하세요",
    avatar: { id: owner.id, displayName: "Owner", alias: "노아", persona: "" },
    conversationId: "conv-1",
    cwd,
    viewerUserId: owner.id,
    viewerName: "Owner",
    viewerIsOwner: true,
    autoApprove: true,
  };
  return { config, store, owner, baseRequest };
}

// ===========================================================================
// runClaudeAgent orchestration (real run loop against the scripted SDK)
// ===========================================================================
describe("runClaudeAgent orchestration (SDK mocked)", () => {
  it("streams session id, model, and deltas, then maps the result + getContextUsage occupancy", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () =>
      handleFrom(
        [
          initMsg("sess-happy", "claude-opus-4-8"),
          startMsg({ input_tokens: 1000, cache_read_input_tokens: 2000 }),
          deltaMsg("Hello "),
          deltaMsg("world"),
          assistantMsg([textBlock("Hello world")], { input_tokens: 10, output_tokens: 5 }),
          successResult("Hello world", {
            usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 3000 },
            modelUsage: { "claude-opus-4-8": { contextWindow: 200000 } },
          }),
        ],
        { getContextUsage: async () => ({ totalTokens: 4200, maxTokens: 200000 }) },
      );

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(events.onSessionId).toHaveBeenCalledWith("sess-happy");
    expect(events.onModel).toHaveBeenCalledWith("claude-opus-4-8");
    expect(events.onDelta).toHaveBeenCalledWith("Hello ");
    expect(events.onDelta).toHaveBeenCalledWith("world");

    expect(response.kind).toBe("text");
    expect(response.runtime).toBe("claude");
    expect(response.summary).toBe("Claude Agent SDK 실행이 완료되었습니다.");
    // Assistant text block wins over the terminal result string (identical here).
    expect(response.text).toBe("Hello world");
    // getContextUsage supersedes the scraped snapshot AND the cumulative result input.
    expect(response.usage).toEqual({
      inputTokens: 4200,
      outputTokens: 20,
      contextWindow: 200000,
    });
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("wires the SDK options: preset system prompt, hook, strict MCP, disallowed tools, default model", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    const { options } = sdkMock.calls[0];
    expect(options.permissionMode).toBe("default");
    expect(options.strictMcpConfig).toBe(true);
    expect(options.skills).toBe("all");
    expect(options.settingSources).toEqual([]);
    expect(options.maxTurns).toBe(config.maxTurns);
    expect(options.cwd).toBe(baseRequest.cwd);
    expect(options.model).toBe(DEFAULT_MODEL_TIER);
    expect(options.disallowedTools).toContain("Workflow");
    expect(options.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    });
    expect(typeof (options.systemPrompt as { append?: unknown }).append).toBe("string");
    // Events present → the PreToolUse hook is registered (the real permission gate).
    const hooks = options.hooks as { PreToolUse?: unknown[] } | undefined;
    expect(Array.isArray(hooks?.PreToolUse)).toBe(true);
    expect(hooks?.PreToolUse).toHaveLength(1);
    // All tool groups on (default) for a plain owner with no repo/groups/ssh/canvas.
    const serverNames = Object.keys(options.mcpServers as Record<string, unknown>);
    expect(serverNames).toEqual(
      expect.arrayContaining(["knowledge", "repo", "system", "confluence", "avatars", "git_repo"]),
    );
    expect(serverNames).not.toContain("canvas");
    expect(serverNames).not.toContain("brain");
    expect(serverNames).not.toContain("group_repo");
    expect(serverNames).not.toContain("ssh_trust");
    // No extra writable dirs (empty plugin roots, no additionalDirs).
    expect(options.additionalDirectories).toBeUndefined();
  });

  it("plumbs the model tier, effort, and MCP tool-group selection into the query options", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg("s", "sonnet"), successResult("ok")]);

    await runAgentStream(
      { ...baseRequest, modelTier: "sonnet", effort: "high", mcpToolGroups: ["system"] },
      [],
      config,
      store,
      events,
    );

    const { options } = sdkMock.calls[0];
    expect(options.model).toBe("sonnet");
    expect(options.effort).toBe("high");
    // Only the `system` group enabled → only the system server is registered.
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toEqual(["system"]);
  });

  it("registers the brain + canvas servers when a repo is connected and canvas is enabled", async () => {
    const { config, store, baseRequest, owner } = setup();
    store.setKnowledgeRepo(owner.id, "owner/kb", "main");
    store.updateProfile(owner.id, { experimentalFeatures: ["canvas"] });
    const events = makeEvents({ onCanvas: vi.fn(async () => ({ behavior: "shown" as const })) });
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    const serverNames = Object.keys(sdkMock.calls[0].options.mcpServers as Record<string, unknown>);
    // repoConfigured + elevated → second brain; canvas feature + onCanvas sink → canvas.
    expect(serverNames).toContain("brain");
    expect(serverNames).toContain("canvas");
    expect(serverNames).toContain("repo");
  });

  it("registers file_output only when an interactive file sink is present", async () => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);
    const onFile = vi.fn(async () => ({
      behavior: "shown" as const,
      attachment: { id: "out-1", kind: "image" as const, mediaType: "image/png" as const },
      url: "/api/conversations/c1/images/out-1",
    }));

    await runAgentStream(baseRequest, [], config, store, makeEvents({ onFile }));

    const options = sdkMock.calls[0].options;
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toContain("file_output");
    expect(options.allowedTools as string[]).toContain("mcp__file_output__show_file");
    expect(options.allowedTools as string[]).toContain("mcp__file_output__share_file");
    expect(JSON.stringify(options.systemPrompt)).toContain("mcp__file_output__show_file");
  });

  it("registers the group repo + group brain servers when the owner belongs to a group with a shared repo", async () => {
    const { config, store, baseRequest, owner } = setup();
    const group = store.createGroup({ name: "팀" });
    store.addGroupMember(group.id, owner.id, "admin");
    store.setGroupKnowledgeRepo(group.id, "team/kb", "main");
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    const serverNames = Object.keys(sdkMock.calls[0].options.mcpServers as Record<string, unknown>);
    // owner in ≥1 group → group_repo; the group has a connected repo → group_brain.
    expect(serverNames).toContain("group_repo");
    expect(serverNames).toContain("group_brain");
  });

  it("allows ask_avatar ONLY on owner-driven runs and never inside a consultation", async () => {
    const { config, store, baseRequest, owner } = setup();
    const group = store.createGroup({ name: "팀" });
    store.addGroupMember(group.id, owner.id, "member");
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    // Owner chat with a group → the consultation tool is allow-listed.
    await runAgentStream(baseRequest, [], config, store, makeEvents());
    expect(sdkMock.calls[0].options.allowedTools as string[]).toContain(
      "mcp__avatars__ask_avatar",
    );

    // A consultation run must never re-register it (the depth guard)...
    await runAgentStream(
      { ...baseRequest, avatarConsultation: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(sdkMock.calls[1].options.allowedTools as string[]).not.toContain(
      "mcp__avatars__ask_avatar",
    );

    // ...nor a teammate turn (not owner-driven)...
    await runAgentStream(
      { ...baseRequest, viewerUserId: "someone-else", viewerIsOwner: false, elevated: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(sdkMock.calls[2].options.allowedTools as string[]).not.toContain(
      "mcp__avatars__ask_avatar",
    );

    // ...nor a restricted headless run (intro/hashtag generation).
    await runAgentStream(
      { ...baseRequest, headless: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(sdkMock.calls[3].options.allowedTools as string[]).not.toContain(
      "mcp__avatars__ask_avatar",
    );
  });

  it("keeps ask_avatar out when the owner belongs to no group (no reachable target)", async () => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, makeEvents());

    const allowedTools = sdkMock.calls[0].options.allowedTools as string[];
    expect(allowedTools).not.toContain("mcp__avatars__ask_avatar");
    // The discovery tool itself stays available.
    expect(allowedTools).toContain("mcp__avatars__search_avatars");
  });

  it("suppresses plugin MCP servers for consultation runs (registration is their only gate)", async () => {
    const { config, store, baseRequest } = setup();
    const rootDir = path.join(tempDir, "consult-plugin-root");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { corp: { command: "node", args: ["server.js"] } } }),
    );
    const roots = [{ type: "local" as const, path: rootDir }];
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    // Control: a normal owner run lifts the plugin server.
    await runAgentStream(baseRequest, roots, config, store, makeEvents());
    expect(
      Object.keys(sdkMock.calls[0].options.mcpServers as Record<string, unknown>),
    ).toContain("corp");

    // A consultation run (trusted-colleague viewer class) gets NO plugin servers.
    await runAgentStream(
      {
        ...baseRequest,
        avatarConsultation: true,
        viewerUserId: "asker-id",
        viewerIsOwner: false,
        elevated: true,
        headless: true,
        allowHeadlessTools: true,
      },
      roots,
      config,
      store,
      makeEvents(),
    );
    expect(
      Object.keys(sdkMock.calls[1].options.mcpServers as Record<string, unknown>),
    ).not.toContain("corp");
  });

  it("emits tool / progress / blocked activity events across the run loop", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () =>
      handleFrom([
        initMsg(),
        assistantMsg([toolUseBlock("t1", "Bash", { command: "ls" })]),
        { type: "tool_progress", tool_name: "Bash" },
        toolResultMsg("t1"),
        {
          type: "system",
          subtype: "permission_denied",
          tool_name: "Edit",
          tool_use_id: "t2",
          agent_id: "main",
          decision_reason: "read-only",
        },
        assistantMsg([textBlock("done")]),
        successResult("done"),
      ]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(events.onToolStart).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: "t1", name: "Bash", agentId: "main", inputSummary: "ls" }),
    );
    expect(events.onToolEnd).toHaveBeenCalledWith({ toolUseId: "t1", ok: true });
    expect(events.onStatus).toHaveBeenCalledWith(expect.stringContaining("실행 중"));
    expect(events.onBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Edit", toolUseId: "t2", reason: "read-only" }),
    );
    expect(response.text).toBe("done");
  });

  it("falls back to the scraped context snapshot when getContextUsage throws", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () =>
      handleFrom(
        [
          initMsg(),
          startMsg({ input_tokens: 3000, cache_read_input_tokens: 1000 }), // snapshot = 4000
          deltaMsg("x"),
          assistantMsg([textBlock("x")]), // no usage → does not override the snapshot
          successResult("x", {
            usage: { input_tokens: 100, output_tokens: 10 },
            modelUsage: { opus: { contextWindow: 200000 } },
          }),
        ],
        {
          getContextUsage: async () => {
            throw new Error("session closing");
          },
        },
      );

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(response.usage).toEqual({ inputTokens: 4000, outputTokens: 10, contextWindow: 200000 });
  });

  it("runs non-streaming (no events) via extractMainAssistantText + the finalizeTurnUsage fallback", async () => {
    const { config, store, baseRequest } = setup();
    // No getContextUsage attached, and no events sink → control method never called.
    sdkMock.impl = () =>
      handleFrom([
        assistantMsg([textBlock("direct answer")], { input_tokens: 1000, cache_read_input_tokens: 500 }),
        successResult("direct answer", {
          usage: { input_tokens: 2000, output_tokens: 50, cache_read_input_tokens: 8000 },
          modelUsage: { opus: { contextWindow: 200000 } },
        }),
      ]);

    const response = await runClaudeAgent(baseRequest, [], config, store);

    expect(response.text).toBe("direct answer");
    // Snapshot (1500) replaces the cumulative result input (10000); output preserved.
    expect(response.usage).toEqual({ inputTokens: 1500, outputTokens: 50, contextWindow: 200000 });
  });

  it("self-heals a missing resume session by re-running without resume and injecting stored history", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const request: AgentRequest = {
      ...baseRequest,
      resumeSessionId: "sess-old",
      conversationHistory: [
        { role: "user", content: "이전 질문" },
        { role: "assistant", content: "이전 답변" },
      ],
    };
    let call = 0;
    sdkMock.impl = () => {
      call += 1;
      if (call === 1) {
        return throwingHandle(new Error("No conversation found with session ID sess-old"));
      }
      return handleFrom([initMsg("sess-new"), successResult("resumed ok")]);
    };

    const response = await runAgentStream(request, [], config, store, events);

    expect(sdkMock.calls).toHaveLength(2);
    // First attempt carried resume; the self-heal dropped it for the retry.
    expect(sdkMock.calls[0].options.resume).toBe("sess-old");
    expect(sdkMock.calls[1].options.resume).toBeUndefined();
    // The retry's prompt (text path, a string) now carries the stored history.
    expect(typeof sdkMock.calls[1].prompt).toBe("string");
    expect(sdkMock.calls[1].prompt as string).toContain("Earlier conversation history");
    expect(sdkMock.calls[1].prompt as string).toContain("이전 질문");
    expect(response.text).toBe("resumed ok");
  });

  it("does NOT self-heal a missing resume when the run was aborted (propagates the error)", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const abort = new AbortController();
    const request: AgentRequest = { ...baseRequest, resumeSessionId: "sess-old" };
    sdkMock.impl = () =>
      throwingHandle(new Error("No conversation found with session ID sess-old"), { abort });

    await expect(runAgentStream(request, [], config, store, events, abort)).rejects.toThrow(
      /no conversation found/i,
    );
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("retries down the model fallback chain on a transient error (scheduled routine)", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const request: AgentRequest = {
      ...baseRequest,
      headless: true,
      allowHeadlessTools: true,
      modelFallback: true,
      modelTier: "opus",
    };
    let call = 0;
    sdkMock.impl = () => {
      call += 1;
      if (call === 1) {
        // Anthropic-style numeric status → retryable via the status branch.
        return throwingHandle(Object.assign(new Error("upstream hiccup"), { status: 503 }));
      }
      return handleFrom([initMsg("s2", "sonnet"), successResult("fell back")]);
    };

    const response = await runAgentStream(request, [], config, store, events);

    expect(sdkMock.calls).toHaveLength(2);
    expect(sdkMock.calls[0].options.model).toBe("opus");
    expect(sdkMock.calls[1].options.model).toBe("sonnet");
    expect(events.onStatus).toHaveBeenCalledWith(expect.stringContaining("sonnet"));
    expect(response.text).toBe("fell back");
  });

  it("falls back from an admin-override (non-tier) model on a transient message-matched error", async () => {
    const { config, store, baseRequest } = setup();
    store.setModelOverride("noah-custom-model"); // concrete id, not a tier alias
    const events = makeEvents();
    const request: AgentRequest = {
      ...baseRequest,
      headless: true,
      allowHeadlessTools: true,
      modelFallback: true,
    };
    let call = 0;
    sdkMock.impl = () => {
      call += 1;
      if (call === 1) {
        return throwingHandle(new Error("Error: overloaded_error, please retry"));
      }
      return handleFrom([initMsg("s2", "sonnet"), successResult("recovered on sonnet")]);
    };

    const response = await runAgentStream(request, [], config, store, events);

    // Non-tier primary → chain is [primary, sonnet, haiku]; first retry lands on sonnet.
    expect(sdkMock.calls[0].options.model).toBe("noah-custom-model");
    expect(sdkMock.calls[1].options.model).toBe("sonnet");
    expect(response.text).toBe("recovered on sonnet");
  });

  it("does NOT fall back on a non-retryable error even when the chain has more tiers", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const request: AgentRequest = {
      ...baseRequest,
      headless: true,
      allowHeadlessTools: true,
      modelFallback: true,
      modelTier: "opus",
    };
    sdkMock.impl = () => throwingHandle(new Error("invalid_request: model does not exist"));

    await expect(runAgentStream(request, [], config, store, events)).rejects.toThrow(/invalid_request/);
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("propagates a transient error when there is no fallback chain (chat behavior)", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => throwingHandle(new Error("overloaded"));

    await expect(runAgentStream(baseRequest, [], config, store, events)).rejects.toThrow("overloaded");
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("keeps the streamed partial text on an error_max_turns result (not the raw error)", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () =>
      handleFrom([
        initMsg(),
        deltaMsg("partial answer"),
        { type: "result", subtype: "error_max_turns", errors: ["Reached maximum number of turns (6)"] },
      ]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(response.text).toBe("partial answer");
    expect(response.usage).toBeUndefined();
  });

  it("returns the friendly Korean error message on an error result with no text anywhere", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), { type: "result", subtype: "error_max_turns" }]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    // Error subtype present → the empty-turn retry is suppressed; friendly text shown.
    expect(response.text).toBe(resultErrorMessage("error_max_turns"));
    expect(response.text).toContain("최대 처리 단계");
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("retries once on an empty (thinking-only) turn and keeps the recovered answer", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    let call = 0;
    sdkMock.impl = () => {
      call += 1;
      if (call === 1) {
        return handleFrom([initMsg(), thinkingMsg("just reasoning, no answer"), successResult("")]);
      }
      return handleFrom([successResult("recovered")]);
    };

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(sdkMock.calls).toHaveLength(2);
    expect(events.onThinkingReset).toHaveBeenCalledTimes(1);
    // The retry prompt carries the empty-turn nudge.
    expect(sdkMock.calls[1].prompt as string).toContain("internal reasoning only");
    expect(response.text).toBe("recovered");
  });

  it("falls back to the empty-response message when the retry is still empty", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("")]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    // First empty turn triggers exactly one retry; the second empty turn gives up.
    expect(sdkMock.calls).toHaveLength(2);
    expect(events.onThinkingReset).toHaveBeenCalledTimes(1);
    expect(response.text).toBe("Claude Agent SDK 응답이 비어 있습니다.");
  });

  it("suppresses the empty-turn retry when the run was aborted mid-stream", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const abort = new AbortController();
    sdkMock.impl = () => {
      async function* gen() {
        yield initMsg("sess-abort");
        abort.abort();
        yield successResult("");
      }
      return gen() as QueryHandle;
    };

    const response = await runAgentStream(baseRequest, [], config, store, events, abort);

    // Aborted → no retry despite an empty turn.
    expect(sdkMock.calls).toHaveLength(1);
    expect(response.text).toBe("Claude Agent SDK 응답이 비어 있습니다.");
  });

  it("builds a streaming-input prompt (image blocks) when the turn carries images", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("saw the image")]);

    const response = await runAgentStream(
      { ...baseRequest, images: [{ mediaType: "image/png", data: "AAAA" }] },
      [],
      config,
      store,
      events,
    );

    // Image turns pass an async-iterable prompt instead of a plain string.
    const prompt = sdkMock.calls[0].prompt as { [Symbol.asyncIterator]?: unknown };
    expect(typeof prompt[Symbol.asyncIterator]).toBe("function");
    expect(response.text).toBe("saw the image");
  });

  it("injects the stored subscription OAuth token, applies autoCompactWindow, and skips non-record messages", async () => {
    const { config, store, baseRequest } = setup({ autoCompactWindow: 150_000 });
    store.setAppSecret(CLAUDE_OAUTH_TOKEN_KEY, "oauth-tok");
    const events = makeEvents();
    sdkMock.impl = () =>
      // A stray non-record message the run loop must skip without throwing.
      handleFrom([null, initMsg(), successResult("ok")]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    const { options } = sdkMock.calls[0];
    expect(options.autoCompactWindow).toBe(150_000);
    const env = options.env as Record<string, string | undefined>;
    // No API key configured → the OAuth token is injected and any empty API key dropped.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(response.text).toBe("ok");
  });

  it("lifts plugin-defined MCP servers and exposes plugin roots as writable directories", async () => {
    const { config, store, baseRequest } = setup();
    const pluginDir = path.join(tempDir, "plugin-root");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".mcp.json"),
      JSON.stringify({ corp: { command: "node", args: ["server.js"] } }),
    );
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(
      baseRequest,
      [{ type: "local", path: pluginDir }],
      config,
      store,
      events,
    );

    const { options } = sdkMock.calls[0];
    // The plugin's .mcp.json server is registered by the app (strictMcpConfig).
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toContain("corp");
    // The plugin root is exposed as an additional writable dir.
    expect(options.additionalDirectories).toEqual([pluginDir]);
  });

  it("shell-exposes an owner secret into env and injects it into an OWNED plugin MCP server", async () => {
    const { config, store, baseRequest, owner } = setup();
    // An owner secret opted into shell exposure (a non-reserved, injectable name).
    store.setUserSecret(owner.id, "MY_API_KEY", "vault-value-123");
    store.setSecretShellExpose(owner.id, "MY_API_KEY", true);
    // An OWNED plugin (under dataDir/plugins/<uid>/…) with a stdio MCP server, so
    // the secret rides in via the one-shot secret-file wrapper.
    const pluginDir = path.join(config.dataDir, "plugins", owner.id, "repo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".mcp.json"),
      JSON.stringify({ corp: { command: "node", args: ["server.js"] } }),
    );
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [{ type: "local", path: pluginDir }], config, store, events);

    const { options } = sdkMock.calls[0];
    // Shell-exposed value reaches the CLI subprocess env on this elevated run.
    expect((options.env as Record<string, string>).MY_API_KEY).toBe("vault-value-123");
    // The owned stdio server was rewritten through the secret-file wrapper (value
    // never in argv), and the secret-value redaction PostToolUse hook is registered.
    const corp = (options.mcpServers as Record<string, { args?: string[] }>).corp;
    expect(corp.args).toContain("--secrets");
    const hooks = options.hooks as { PostToolUse?: unknown[] };
    expect(Array.isArray(hooks.PostToolUse)).toBe(true);
    // The one-shot secret file was written to disk (consumed by the wrapper at runtime).
    const secretsDir = path.join(config.dataDir, "runtime", "mcp-secrets");
    expect(fs.readdirSync(secretsDir).length).toBeGreaterThan(0);
  });

  it("sweeps stale one-shot MCP secret files older than the max age", async () => {
    const { config, store, baseRequest } = setup();
    const secretsDir = path.join(config.dataDir, "runtime", "mcp-secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const staleFile = path.join(secretsDir, "plugin-old.json");
    fs.writeFileSync(staleFile, "{}");
    // Backdate it two hours (the sweep threshold is one hour).
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(staleFile, old / 1000, old / 1000);
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    expect(fs.existsSync(staleFile)).toBe(false);
  });
});

// ===========================================================================
// buildImageQueryPrompt (direct — the run loop never consumes it under the mock)
// ===========================================================================
describe("buildImageQueryPrompt", () => {
  it("yields exactly one SDK user message with the prompt text followed by image blocks", async () => {
    const gen = buildImageQueryPrompt("look at these", [
      { mediaType: "image/png", data: "AAAA" },
      { mediaType: "image/jpeg", data: "BBBB" },
    ]);
    const first = await gen.next();
    expect(first.done).toBe(false);
    const message = first.value as {
      type: string;
      parent_tool_use_id: unknown;
      message: { role: string; content: Record<string, unknown>[] };
    };
    expect(message.type).toBe("user");
    expect(message.parent_tool_use_id).toBeNull();
    expect(message.message.role).toBe("user");
    expect(message.message.content[0]).toEqual({ type: "text", text: "look at these" });
    expect(message.message.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(message.message.content[2]).toMatchObject({
      source: { media_type: "image/jpeg", data: "BBBB" },
    });
    // The stream closes after the single message (one turn).
    expect((await gen.next()).done).toBe(true);
  });
});

// ===========================================================================
// runRegistry — coverage of the branches not exercised by agent-core.test.ts
// ===========================================================================
interface SseSink {
  res: Response;
  chunks: string[];
  setThrow: (v: boolean) => void;
  setEnded: (v: boolean) => void;
}

function makeSseSink(): SseSink {
  const chunks: string[] = [];
  let ended = false;
  let throwOnWrite = false;
  const handlers = new Map<string, () => void>();
  const res = {
    get writableEnded() {
      return ended;
    },
    write(chunk: string) {
      if (throwOnWrite) {
        throw new Error("EPIPE");
      }
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
      handlers.get("close")?.();
    },
    on(event: string, cb: () => void) {
      handlers.set(event, cb);
      return this;
    },
  } as unknown as Response;
  return {
    res,
    chunks,
    setThrow: (v) => {
      throwOnWrite = v;
    },
    setEnded: (v) => {
      ended = v;
    },
  };
}

describe("runRegistry (additional coverage)", () => {
  it("getActiveRun resolves by id and rejects unknown / wrong-user / ended runs", () => {
    openRun("ar-1", "u", { conversationId: "c-ar", avatarId: "av" });
    expect(getActiveRun("ar-1", "u")).toMatchObject({
      runId: "ar-1",
      conversationId: "c-ar",
      avatarId: "av",
      eventCount: 0,
      pendingCount: 0,
      cancelled: false,
    });
    expect(getActiveRun("ar-1", "intruder")).toBeNull();
    expect(getActiveRun("ghost", "u")).toBeNull();
    closeRun("ar-1");
    expect(getActiveRun("ar-1", "u")).toBeNull();
  });

  it("cancelAllRuns aborts every controller and unparks pending prompts (shutdown)", async () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    openRun("all-1", "u", { abortController: ac1 });
    openRun("all-2", "u2", { conversationId: "c2", abortController: ac2 });
    const p1 = awaitResponse("all-1", "r1");
    const p2 = awaitResponse("all-2", "r2");

    cancelAllRuns();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(isRunCancelled("all-1")).toBe(true);
    await expect(p1).resolves.toBe(CANCELLED);
    await expect(p2).resolves.toBe(CANCELLED);
    closeRun("all-1");
    closeRun("all-2");
  });

  it("submitResponse clears the pending timeout and rejects unknown / wrong-user / no-pending", async () => {
    expect(submitResponse("ghost", "req", "u", {})).toBe(false); // unknown run
    openRun("sr-1", "u");
    const parked = awaitResponse("sr-1", "req"); // sets the auto-cancel timeout
    expect(submitResponse("sr-1", "req", "intruder", {})).toBe(false); // wrong user
    expect(submitResponse("sr-1", "other-req", "u", {})).toBe(false); // no such pending
    expect(submitResponse("sr-1", "req", "u", { behavior: "allow" })).toBe(true);
    await expect(parked).resolves.toEqual({ behavior: "allow" });
    closeRun("sr-1");
  });

  it("cancelRun marks cancelled, aborts the controller, unparks prompts, and rejects wrong users", async () => {
    const ac = new AbortController();
    openRun("cr-1", "u", { conversationId: "c-cr", abortController: ac });
    const parked = awaitResponse("cr-1", "req");
    expect(cancelRun("cr-1", "intruder")).toBe(false);
    expect(cancelRun("cr-1", "u")).toBe(true);
    expect(isRunCancelled("cr-1")).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    await expect(parked).resolves.toBe(CANCELLED);
    closeRun("cr-1");
  });

  it("awaitResponse resolves CANCELLED for an unknown run and closeRun no-ops on an unknown id", async () => {
    await expect(awaitResponse("ghost", "req")).resolves.toBe(CANCELLED);
    expect(() => closeRun("never-opened")).not.toThrow();
  });

  it("attachRunClient replays buffered events after the given event id", () => {
    openRun("rp-1", "u");
    emitRunEvent("rp-1", "status", { label: "first" });
    emitRunEvent("rp-1", "status", { label: "second" });
    const sink = makeSseSink();
    attachRunClient("rp-1", "u", sink.res, 1); // since id 1 → only the second frame
    const replayed = sink.chunks.join("");
    expect(replayed).toContain("second");
    expect(replayed).not.toContain("first");
    closeRun("rp-1");
  });

  it("getActiveRunForConversation clears a stale conversation→run mapping", () => {
    openRun("st-1", "u", { conversationId: "c-old" });
    // Reusing the runId for a new conversation leaves the old key dangling; the
    // close then removes only the new key + the run, so the old key is now stale.
    openRun("st-1", "u", { conversationId: "c-new" });
    closeRun("st-1");
    expect(getActiveRunForConversation("u", "c-old")).toBeNull();
    // Idempotent — the stale entry was pruned on the first lookup.
    expect(getActiveRunForConversation("u", "c-old")).toBeNull();
  });

  it("awaitResponse auto-cancels a parked prompt after the TTL and notifies clients", async () => {
    vi.useFakeTimers();
    try {
      openRun("to-1", "u", { conversationId: "c-to" });
      const sink = makeSseSink();
      attachRunClient("to-1", "u", sink.res);
      const parked = awaitResponse("to-1", "req-to");

      vi.advanceTimersByTime(30 * 60 * 1000 + 1000);

      await expect(parked).resolves.toBe(CANCELLED);
      expect(sink.chunks.join("")).toContain("event: prompt_resolved");
      closeRun("to-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("heartbeat pings the client, then detaches once the response has ended", () => {
    vi.useFakeTimers();
    try {
      openRun("hb-1", "u");
      const sink = makeSseSink();
      attachRunClient("hb-1", "u", sink.res);

      vi.advanceTimersByTime(15_000);
      const pingsAfterFirst = sink.chunks.filter((c) => c === ": ping\n\n").length;
      expect(pingsAfterFirst).toBeGreaterThan(0);

      sink.setEnded(true); // res.writableEnded → the next heartbeat detaches
      vi.advanceTimersByTime(15_000);
      expect(sink.chunks.filter((c) => c === ": ping\n\n").length).toBe(pingsAfterFirst);
      closeRun("hb-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("heartbeat detaches the client when a ping write throws", () => {
    vi.useFakeTimers();
    try {
      openRun("hb-2", "u");
      const sink = makeSseSink();
      sink.setThrow(true); // every write throws
      attachRunClient("hb-2", "u", sink.res);

      vi.advanceTimersByTime(15_000); // ping write throws → detach (clearInterval)
      vi.advanceTimersByTime(15_000); // interval cleared → no further callback
      expect(sink.chunks).toHaveLength(0);
      closeRun("hb-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emitRunEvent detaches a client whose write fails or whose response already ended", () => {
    openRun("em-1", "u");
    const sink = makeSseSink();
    attachRunClient("em-1", "u", sink.res);
    expect(emitRunEvent("em-1", "status", { label: "a" })).toBe(true);
    expect(sink.chunks.join("")).toContain("event: status");

    // Write now throws → writeSse catch returns false → the client is detached.
    sink.setThrow(true);
    emitRunEvent("em-1", "status", { label: "b" });
    sink.setThrow(false);
    const before = sink.chunks.length;
    emitRunEvent("em-1", "status", { label: "c" });
    expect(sink.chunks.length).toBe(before); // detached client no longer receives events
    closeRun("em-1");

    // Separately, a client whose response has ended is dropped on the next emit.
    openRun("em-2", "u");
    const ended = makeSseSink();
    attachRunClient("em-2", "u", ended.res);
    ended.setEnded(true);
    emitRunEvent("em-2", "status", { label: "x" }); // writableEnded → writeSse false → detach
    ended.setEnded(false);
    const before2 = ended.chunks.length;
    emitRunEvent("em-2", "status", { label: "y" });
    expect(ended.chunks.length).toBe(before2);
    closeRun("em-2");
  });

  it("emitRunEvent and attachRunClient reject unknown, ended, and wrong-user runs", () => {
    expect(emitRunEvent("ghost", "e", {})).toBe(false);
    const sink = makeSseSink();
    expect(attachRunClient("ghost", "u", sink.res)).toBe(false);

    openRun("ae-1", "u");
    expect(attachRunClient("ae-1", "intruder", sink.res)).toBe(false); // wrong user
    closeRun("ae-1");
    expect(attachRunClient("ae-1", "u", sink.res)).toBe(false); // gone after close
    expect(emitRunEvent("ae-1", "e", {})).toBe(false);
  });

  it("getActiveRunForConversation resolves the active run and returns null for an unknown key", () => {
    openRun("gc-1", "u", { conversationId: "c-gc", avatarId: "a" });
    expect(getActiveRunForConversation("u", "c-gc")?.runId).toBe("gc-1");
    expect(getActiveRunForConversation("u", "no-such-conv")).toBeNull();
    expect(getActiveRunForConversation("other", "c-gc")).toBeNull(); // key is per-user
    closeRun("gc-1");
    expect(getActiveRunForConversation("u", "c-gc")).toBeNull();
  });
});
