import type { AppConfig, AgentRequest, AgentResponse } from "../types.js";
import type { MarketplaceRegistry } from "../marketplace.js";
import { runClaudeAgent } from "./claudeAgent.js";
import { isMutatingRequest, runLocalAgent } from "./localRunner.js";

export async function runAgent(
  request: AgentRequest,
  registry: MarketplaceRegistry,
  config: AppConfig,
): Promise<AgentResponse> {
  if (request.mode === "colleague" && isMutatingRequest(request.message)) {
    return {
      kind: "text",
      runtime: "blocked",
      summary: "동료 모드는 읽기 전용입니다.",
      text: "변경 가능성이 있는 요청은 동료 모드에서 차단했습니다.",
    };
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
