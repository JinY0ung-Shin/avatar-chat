import type { AppConfig, AgentRequest, AgentResponse } from "../types.js";
import type { MarketplaceRegistry } from "../marketplace.js";
import type { AgentEvents } from "./events.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractAssistantText(message: unknown): string {
  if (!isRecord(message) || message.type !== "assistant") {
    return "";
  }
  const messageRecord = isRecord(message.message) ? message.message : undefined;
  const content = messageRecord?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (isRecord(block) && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractResultText(message: unknown): string {
  if (isRecord(message) && message.type === "result" && typeof message.result === "string") {
    return message.result;
  }
  return "";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a single SDK `stream_event` message and fire the matching streaming
 * callbacks. Returns the text delta (if any) so callers can also accumulate it
 * for the authoritative final text when no result/assistant text arrives.
 */
function handleStreamEvent(message: Record<string, unknown>, events: AgentEvents): string {
  const event = isRecord(message.event) ? message.event : undefined;
  if (!event) {
    return "";
  }

  // Incremental assistant text: content_block_delta -> text_delta.
  if (event.type === "content_block_delta" && isRecord(event.delta) && event.delta.type === "text_delta") {
    const text = asString(event.delta.text);
    if (text) {
      events.onDelta?.(text);
    }
    return text;
  }

  // Tool/skill invocation start: content_block_start -> tool_use.
  if (
    event.type === "content_block_start" &&
    isRecord(event.content_block) &&
    event.content_block.type === "tool_use"
  ) {
    const name = asString(event.content_block.name);
    if (name) {
      events.onTool?.(name);
      events.onStatus?.(`도구 실행 중: ${name}`);
    }
  }

  return "";
}

/**
 * Parse a single SDK `system` message and fire status/plugin callbacks.
 */
function handleSystemEvent(message: Record<string, unknown>, events: AgentEvents): void {
  const subtype = asString(message.subtype);
  if (subtype === "init") {
    const model = asString(message.model);
    events.onStatus?.(model ? `Claude 준비 완료 (${model})` : "Claude 준비 완료");
    // The init payload may enumerate loaded plugins under a few possible keys.
    const pluginList =
      (Array.isArray(message.plugins) && message.plugins) ||
      (Array.isArray(message.loadedPlugins) && message.loadedPlugins) ||
      [];
    for (const entry of pluginList) {
      let name = "";
      if (typeof entry === "string") {
        name = entry;
      } else if (isRecord(entry)) {
        name = asString(entry.name);
      }
      if (name) {
        events.onPlugin?.({ status: "completed", name });
      }
    }
    return;
  }
  if (subtype === "plugin_install") {
    const name = asString(message.name);
    const status = asString(message.status);
    const normalized: "started" | "installed" | "failed" | "completed" =
      status === "started" || status === "installed" || status === "failed" || status === "completed"
        ? status
        : "started";
    events.onPlugin?.({ status: normalized, name });
    if (name) {
      events.onStatus?.(`플러그인 불러오는 중… (${name})`);
    } else {
      events.onStatus?.("플러그인 불러오는 중…");
    }
    return;
  }
  if (subtype === "status") {
    const status = asString(message.status);
    const label =
      status === "requesting"
        ? "응답 생성 중…"
        : status === "compacting"
          ? "맥락 정리 중…"
          : "처리 중…";
    events.onStatus?.(label);
  }
}

function buildPrompt(request: AgentRequest): string {
  const common = [
    `사용자: ${request.user.name}`,
    `프로젝트 범위: ${request.user.projectScope}`,
    `모드: ${request.mode}`,
    "marketplace plugin/skill을 사용해서 요청을 처리하고, 어떤 skill을 사용했는지 짧게 밝혀라.",
  ];
  if (request.mode === "colleague") {
    common.push(
      "동료 모드는 읽기 전용이다. 재시작, 재배포, 삭제, 생성, 권한 변경, 외부 전송 등 변경 작업은 수행하지 말고 거절하라.",
      "다른 프로젝트 정보는 노출하지 말고, 가능하면 상태표 형태로 답하라.",
    );
  } else {
    common.push("소유자 모드다. marketplace skill의 자체 정책과 지침을 따른다.");
  }
  return `${common.join("\n")}\n\n요청:\n${request.message}`;
}

export async function runClaudeAgent(
  request: AgentRequest,
  registry: MarketplaceRegistry,
  config: AppConfig,
  events?: AgentEvents,
  abortController?: AbortController,
): Promise<AgentResponse> {
  // ANTHROPIC_API_KEY is optional: when it is absent the Claude Agent SDK falls
  // back to the local Claude Code authentication (subscription login).
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: (input: unknown) => AsyncIterable<unknown>;
  };
  // Install every plugin found in the configured marketplace. Colleague-mode
  // safety is enforced below via permissionMode/allowed/disallowed tools and the
  // mutating-request block in runAgent, not by hiding plugins.
  const pluginRoots = registry.plugins.map((plugin) => ({
    type: "local",
    path: plugin.rootPath,
  }));

  // Streaming is opt-in: only request partial messages from the SDK when the
  // caller passes an events sink. With no events this path is byte-for-byte
  // equivalent to the original non-streaming behavior, so POST /api/chat is
  // unchanged.
  const streaming = Boolean(events);

  const baseOptions =
    request.mode === "colleague"
      ? {
          plugins: pluginRoots,
          permissionMode: "dontAsk",
          allowedTools: config.colleagueAllowedTools,
          disallowedTools: ["Write", "Edit"],
          maxTurns: 4,
        }
      : {
          plugins: pluginRoots,
          permissionMode: config.ownerPermissionMode,
          maxTurns: 8,
        };

  // Build options as a loose record so we can layer streaming + cancellation on
  // top of the mode-specific base without fighting the union type.
  const options: Record<string, unknown> = { ...baseOptions };
  if (streaming) {
    options.includePartialMessages = true;
  }
  // When provided, the abort controller lets the caller (SSE handler) cancel the
  // SDK run on client Stop/disconnect so tools stop executing and tokens stop
  // generating server-side.
  if (abortController) {
    options.abortController = abortController;
  }

  if (events) {
    events.onStatus?.("응답 생성 중…");
  }

  const assistantChunks: string[] = [];
  const deltaChunks: string[] = [];
  let resultText = "";

  for await (const message of sdk.query({
    prompt: buildPrompt(request),
    options,
  })) {
    if (events && isRecord(message)) {
      if (message.type === "stream_event") {
        const delta = handleStreamEvent(message, events);
        if (delta) {
          deltaChunks.push(delta);
        }
        // stream_event carries the same text as the assistant message that
        // follows; the assistant message is handled below only for the
        // non-streaming text accumulation, and we skip pushing it as deltas to
        // avoid duplicating the streamed output.
        continue;
      }
      if (message.type === "system") {
        handleSystemEvent(message, events);
        // fall through so non-text system messages don't affect text capture
      }
      if (message.type === "tool_progress") {
        const toolName = asString(message.tool_name) || asString(message.toolName);
        events.onStatus?.(toolName ? `실행 중: ${toolName}` : "실행 중…");
        continue;
      }
    }

    const assistantText = extractAssistantText(message);
    if (assistantText) {
      assistantChunks.push(assistantText);
    }
    const extractedResult = extractResultText(message);
    if (extractedResult) {
      resultText = extractedResult;
    }
  }

  const text =
    resultText ||
    assistantChunks.join("\n\n").trim() ||
    deltaChunks.join("").trim() ||
    "Claude Agent SDK 응답이 비어 있습니다.";
  return {
    kind: "text",
    runtime: "claude",
    summary: "Claude Agent SDK 실행이 완료되었습니다.",
    text,
  };
}
