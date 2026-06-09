import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";

/** Per-conversation context the knowledge tools act within. */
export interface KnowledgeToolsContext {
  /** The avatar (== owner user) whose knowledge base these tools touch. */
  avatarUserId: string;
  /** True when the current viewer is the avatar's owner. */
  viewerIsOwner: boolean;
  /** The colleague currently chatting (for attributing requests). */
  askerUserId?: string | null;
  askerName?: string | null;
}

/** MCP server name; tools surface to the model as `mcp__knowledge__<tool>`. */
export const KNOWLEDGE_SERVER_NAME = "knowledge";

/** Tool names the model may call, in `allowedTools` form. */
export const KNOWLEDGE_TOOL_NAMES = [
  "mcp__knowledge__recall_knowledge",
  "mcp__knowledge__request_info",
  "mcp__knowledge__pending_requests",
  "mcp__knowledge__save_knowledge",
] as const;

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

const OWNER_ONLY = "이 도구는 아바타 소유자만 사용할 수 있습니다.";

/**
 * Build the knowledge-backfill tool definitions bound to a single
 * conversation's store + context. Exposed separately from the server so the
 * handlers can be exercised directly in tests. Owner-only tools are enforced
 * here (the model can call them, but a non-owner gets a refusal result).
 */
export function buildKnowledgeTools(store: Store, ctx: KnowledgeToolsContext) {
  return [
      tool(
        "recall_knowledge",
        "소유자가 가르쳐 둔 지식을 검색한다. 소유자만 알 법한 정보를 묻는 질문에 답하기 전에 먼저 호출하라.",
        { query: z.string().describe("검색할 핵심 키워드 또는 질문") },
        async (args) => {
          const matches = store.searchKnowledge(ctx.avatarUserId, args.query);
          if (matches.length === 0) {
            return text("관련된 저장 지식이 없습니다.");
          }
          const body = matches
            .map((m, i) => `${i + 1}. ${m.topic ? `[${m.topic}] ` : ""}${m.content}`)
            .join("\n");
          return text(`저장된 지식 ${matches.length}건:\n${body}`);
        },
      ),
      tool(
        "request_info",
        "아바타가 모르는, 소유자만 알 법한 정보를 소유자에게 전달할 요청으로 기록한다.",
        { question: z.string().describe("소유자가 답할 수 있도록 맥락을 담은 한 문장 질문") },
        async (args) => {
          const req = store.addKnowledgeRequest(ctx.avatarUserId, {
            question: args.question,
            askerUserId: ctx.askerUserId ?? null,
            askerName: ctx.askerName ?? null,
          });
          return text(`정보 요청을 소유자에게 전달했습니다. (요청 id: ${req.id})`);
        },
      ),
      tool(
        "pending_requests",
        "소유자에게 전달된, 아직 답변되지 않은 정보 요청 목록을 가져온다. (소유자 전용)",
        {},
        async () => {
          if (!ctx.viewerIsOwner) {
            return text(OWNER_ONLY, true);
          }
          const open = store.listKnowledgeRequests(ctx.avatarUserId, "open");
          if (open.length === 0) {
            return text("대기 중인 정보 요청이 없습니다.");
          }
          const body = open
            .map(
              (r, i) =>
                `${i + 1}. (id: ${r.id}) ${r.question}${r.askerName ? ` — 질문자: ${r.askerName}` : ""}`,
            )
            .join("\n");
          return text(`대기 중인 정보 요청 ${open.length}건:\n${body}`);
        },
      ),
      tool(
        "save_knowledge",
        "소유자가 알려준 답을 아바타 지식으로 저장한다. 특정 요청에 대한 답이면 request_id를 함께 넘긴다. (소유자 전용)",
        {
          answer: z.string().describe("저장할 지식 내용 (소유자의 답)"),
          question: z
            .string()
            .optional()
            .describe("이 지식이 답하는 질문/주제 (요청과 무관하게 저장할 때)"),
          request_id: z
            .string()
            .optional()
            .describe("이 답이 해결하는 정보 요청의 id (pending_requests에서 얻음)"),
        },
        async (args) => {
          if (!ctx.viewerIsOwner) {
            return text(OWNER_ONLY, true);
          }
          if (args.request_id) {
            const resolved = store.answerKnowledgeRequest(
              ctx.avatarUserId,
              args.request_id,
              args.answer,
            );
            if (!resolved) {
              return text(`요청 id ${args.request_id} 를 찾을 수 없습니다.`, true);
            }
            return text(`요청에 답하고 지식으로 저장했습니다: "${resolved.question}"`);
          }
          const entry = store.addKnowledgeEntry(ctx.avatarUserId, {
            topic: args.question ?? null,
            content: args.answer,
          });
          return text(`지식으로 저장했습니다.${entry.topic ? ` (주제: ${entry.topic})` : ""}`);
        },
      ),
  ];
}

/**
 * Build the in-process MCP server exposing the knowledge-backfill tools, bound
 * to a single conversation's store + context.
 */
export function buildKnowledgeServer(store: Store, ctx: KnowledgeToolsContext) {
  return createSdkMcpServer({
    name: KNOWLEDGE_SERVER_NAME,
    version: "0.1.0",
    tools: buildKnowledgeTools(store, ctx),
  });
}
