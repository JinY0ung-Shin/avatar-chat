import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AvatarSummary } from "../types.js";

/** Per-conversation context the avatar-directory tool acts within. */
export interface AvatarDirectoryContext {
  /** The avatar being chatted with — excluded from its own search results. */
  avatarUserId: string;
  /** The viewer currently chatting; published-avatar visibility is from their POV. */
  viewerUserId: string;
}

/** MCP server name; tools surface to the model as `mcp__avatars__<tool>`. */
export const AVATAR_DIRECTORY_SERVER_NAME = "avatars";

/** Tool names the model may call, in `allowedTools` form. */
export const AVATAR_DIRECTORY_TOOL_NAMES = ["mcp__avatars__search_avatars"] as const;

/** How many matching avatars a single search returns. */
const SEARCH_LIMIT = 8;

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

/** One result line: handle, name/alias, capability hashtags, and a short bio. */
function formatAvatar(av: AvatarSummary): string {
  const name = av.alias ? `${av.displayName} ("${av.alias}")` : av.displayName;
  const tags = av.hashtags.length ? av.hashtags.map((t) => `#${t}`).join(" ") : "(해시태그 없음)";
  // Bio is user-controlled and flows into the searching avatar's model as tool
  // output, so keep it short — bounds the result size and the injection surface.
  const trimmed = av.bio?.trim() ?? "";
  const bio = trimmed ? ` — ${trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed}` : "";
  return `- @${av.username} · ${name}: ${tags}${bio}`;
}

/**
 * Build the avatar-directory tool definitions. Exposed separately from the
 * server so the handler can be exercised directly in tests. NOT owner-only:
 * this only surfaces PUBLISHED avatars (plus the viewer's own), which the
 * viewer can already browse in 탐색 — it just lets the avatar do the lookup
 * for the user mid-conversation.
 */
export function buildAvatarDirectoryTools(store: Store, ctx: AvatarDirectoryContext) {
  return [
    tool(
      "search_avatars",
      "다른 아바타(동료들의 공개 아바타)가 무엇을 할 수 있는지 역량 해시태그·소개·이름으로 검색한다. " +
        "사용자가 요청한 일이 당신의 역량 밖이거나, 그 주제에 더 적합한 다른 아바타가 있을 것 같을 때 사용하라. " +
        "검색 결과의 아바타가 더 적합하면 사용자에게 그 아바타(@사용자명)와 대화해 보라고 안내하라. " +
        "공개된 아바타만 검색되며(=사용자가 탐색에서 볼 수 있는 범위), 당신 자신은 결과에서 제외된다.",
      {
        query: z
          .string()
          .describe("찾고 싶은 역량/주제 키워드. 예: '코드리뷰', '데이터 분석', '쿠버네티스'. 비우면 공개 아바타를 두루 나열한다."),
      },
      async (args) => {
        const results = store.searchAvatars(ctx.viewerUserId, args.query ?? "", {
          excludeId: ctx.avatarUserId,
          limit: SEARCH_LIMIT,
        });
        if (results.length === 0) {
          return text(
            args.query?.trim()
              ? `"${args.query.trim()}"에 맞는 공개 아바타를 찾지 못했습니다.`
              : "검색할 수 있는 다른 공개 아바타가 없습니다.",
          );
        }
        const header = args.query?.trim()
          ? `"${args.query.trim()}" 관련 공개 아바타 ${results.length}명:`
          : `공개 아바타 ${results.length}명:`;
        return text(`${header}\n${results.map(formatAvatar).join("\n")}`);
      },
    ),
  ];
}

/**
 * Build the in-process MCP server exposing the avatar-directory tool, bound to a
 * single conversation's store + context.
 */
export function buildAvatarDirectoryServer(store: Store, ctx: AvatarDirectoryContext) {
  return createSdkMcpServer({
    name: AVATAR_DIRECTORY_SERVER_NAME,
    version: "0.1.0",
    tools: buildAvatarDirectoryTools(store, ctx),
  });
}
