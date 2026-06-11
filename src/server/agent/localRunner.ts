import type { AgentRequest, AgentResponse } from "../types.js";

/**
 * Deterministic offline stub used when AGENT_RUNTIME=local. Executes no plugins
 * and never touches the network, keeping tests fast and reproducible.
 */
export function runLocalAgent(request: AgentRequest): AgentResponse {
  const text = request.greeting
    ? `[local] 안녕하세요, ${request.avatar.displayName}입니다. 무엇을 도와드릴까요?`
    : `[local] ${request.message}`;
  return {
    kind: "text",
    runtime: "local",
    summary: "(로컬 런타임 응답)",
    text,
  };
}
