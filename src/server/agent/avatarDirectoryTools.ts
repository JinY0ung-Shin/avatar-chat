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
  const tags = av.hashtags.length ? av.hashtags.map((t) => `#${t}`).join(" ") : "(no hashtags)";
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
      "Searches what other avatars (colleagues' published avatars) can do, by capability hashtags, intro, and name. " +
        "Use this when the task the user requested is outside your capabilities, or when there is likely another avatar better suited to that topic. " +
        "If an avatar in the search results is a better fit, guide the user to chat with that avatar (@username). " +
        "Only published avatars are searched (= the scope the user can see in discovery), and you yourself are excluded from the results.",
      {
        query: z
          .string()
          .describe("Capability/topic keywords you want to find. e.g.: 'code review', 'data analysis', 'kubernetes'. If empty, lists published avatars broadly."),
      },
      async (args) => {
        const results = store.searchAvatars(ctx.viewerUserId, args.query ?? "", {
          excludeId: ctx.avatarUserId,
          limit: SEARCH_LIMIT,
        });
        if (results.length === 0) {
          return text(
            args.query?.trim()
              ? `Could not find any published avatar matching "${args.query.trim()}".`
              : "There are no other published avatars available to search.",
          );
        }
        const header = args.query?.trim()
          ? `${results.length} published avatar(s) related to "${args.query.trim()}":`
          : `${results.length} published avatar(s):`;
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
