import type { AppConfig, AgentRequest, AgentResponse } from "../types.js";
import type { MarketplaceRegistry } from "../marketplace.js";
import { runClaudeAgent } from "./claudeAgent.js";
import { isMutatingRequest, runLocalAgent } from "./localRunner.js";
import type { AgentEvents } from "./events.js";

export type { AgentEvents, PluginEvent, PluginStatus } from "./events.js";

function blockedResponse(): AgentResponse {
  return {
    kind: "text",
    runtime: "blocked",
    summary: "동료 모드는 읽기 전용입니다.",
    text: "변경 가능성이 있는 요청은 동료 모드에서 차단했습니다.",
  };
}

export async function runAgent(
  request: AgentRequest,
  registry: MarketplaceRegistry,
  config: AppConfig,
): Promise<AgentResponse> {
  if (request.mode === "colleague" && isMutatingRequest(request.message)) {
    return blockedResponse();
  }

  // Always use the Claude Agent SDK unless the runtime is explicitly set to
  // "local". The SDK works without ANTHROPIC_API_KEY by using the local Claude
  // Code authentication, so an API key is no longer required.
  if (config.agentRuntime !== "local") {
    try {
      return await runClaudeAgent(request, registry, config);
    } catch (error) {
      // In "auto" we degrade gracefully to local runners; in "claude" we surface
      // the failure so the SDK-only requirement stays explicit.
      if (config.agentRuntime === "claude") {
        throw error;
      }
    }
  }

  return runLocalAgent(request, registry);
}

const LOCAL_CHUNK_SIZE = 40;

/**
 * Chunk an already-computed text into ~40-char slices and emit each via
 * onDelta, giving locally-produced responses a streamed feel. We split on a
 * code-point boundary (spread to array) so multi-byte Korean characters are
 * never cut in half.
 */
function streamLocalText(text: string, events: AgentEvents): void {
  if (!events.onDelta || !text) {
    return;
  }
  const codePoints = Array.from(text);
  for (let index = 0; index < codePoints.length; index += LOCAL_CHUNK_SIZE) {
    events.onDelta(codePoints.slice(index, index + LOCAL_CHUNK_SIZE).join(""));
  }
}

/**
 * Streaming counterpart to runAgent. Mirrors runAgent's mutating-block and
 * auto/claude fallback semantics. For the claude runtime it forwards the events
 * sink so the SDK streams token-by-token; for the local runtime it runs the
 * (non-streaming) local agent then replays its text through onDelta so the
 * client still renders incrementally.
 */
export async function runAgentStream(
  request: AgentRequest,
  registry: MarketplaceRegistry,
  config: AppConfig,
  events: AgentEvents,
  abortController?: AbortController,
): Promise<AgentResponse> {
  if (request.mode === "colleague" && isMutatingRequest(request.message)) {
    // No streaming for the blocked case — the SSE handler emits a single done.
    return blockedResponse();
  }

  if (config.agentRuntime !== "local") {
    try {
      return await runClaudeAgent(request, registry, config, events, abortController);
    } catch (error) {
      if (config.agentRuntime === "claude") {
        throw error;
      }
    }
  }

  events.onStatus?.("응답 생성 중…");
  const response = await runLocalAgent(request, registry);
  // Only replay plain text; table responses are delivered authoritatively via
  // the final `done` frame (the client renders the table from `response`).
  if (response.kind === "text" && typeof response.text === "string") {
    streamLocalText(response.text, events);
  }
  return response;
}
