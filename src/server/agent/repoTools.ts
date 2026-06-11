import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig } from "../types.js";
import { scrubGitError } from "../marketplace.js";
import {
  commitAndPush,
  commitIdentityFor,
  ensureClone,
  knowledgeRepoContextFor,
  listTree,
  readFile as readRepoFile,
  scaffoldSkill,
  writeFile as writeRepoFile,
} from "../knowledgeRepo.js";

/**
 * Per-conversation context the knowledge-repo management tools act within. These
 * tools let the avatar manage its OWNER's personal knowledge repo (the repo the
 * avatar accumulates work knowledge/skills into) directly from chat. They are
 * OWNER-ONLY: a colleague, a trusted user, or a headless routine gets a refusal.
 */
export interface RepoToolsContext {
  /** The avatar (== owner) whose knowledge repo these tools manage. */
  avatarUserId: string;
  /** The avatar owner (for the username/displayName fallback in commits). */
  owner: { id: string; username: string; displayName: string };
  /**
   * True only when the present viewer IS the owner and the run is interactive.
   * The caller computes `viewerIsOwner && !headless`; every tool refuses otherwise.
   */
  viewerIsOwner: boolean;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__repo__<tool>`. */
export const REPO_SERVER_NAME = "repo";

/** Tool names the model may call, in `allowedTools` form. */
export const REPO_TOOL_NAMES = [
  "mcp__repo__list_files",
  "mcp__repo__read_file",
  "mcp__repo__write_file",
  "mcp__repo__scaffold_skill",
  "mcp__repo__commit",
] as const;

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

const OWNER_ONLY = "이 도구는 아바타 소유자만 사용할 수 있습니다.";
const NO_REPO =
  "지식 저장소가 설정되지 않았습니다. 설정에서 먼저 저장소를 연결해 주세요.";

/**
 * Build the knowledge-repo management tool definitions bound to a single
 * conversation's store + context. Exposed separately from the server so the
 * handlers can be exercised directly in tests. Owner-only gating is enforced
 * here (the model can call them, but a non-owner gets a refusal result).
 */
export function buildRepoTools(store: Store, ctx: RepoToolsContext) {
  // Resolve the repo context fresh on each call so a token/repo change mid-
  // conversation is picked up. Returns null when no repo is configured.
  const repoCtx = () => knowledgeRepoContextFor(store, ctx.avatarUserId, ctx.config);

  return [
    tool(
      "list_files",
      "내 지식 저장소(개인 repo)의 파일 목록을 가져온다. (소유자 전용)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const c = repoCtx();
        if (!c) {
          return text(NO_REPO, true);
        }
        try {
          const repoRoot = await ensureClone(c);
          const entries = await listTree(repoRoot);
          if (entries.length === 0) {
            return text("(빈 저장소입니다.)");
          }
          const body = entries
            .map((e) => (e.type === "dir" ? `${e.path}/` : e.path))
            .join("\n");
          return text(`지식 저장소 파일 목록:\n${body}`);
        } catch (error) {
          return text(`저장소를 불러오지 못했습니다: ${scrubGitError(error)}`, true);
        }
      },
    ),
    tool(
      "read_file",
      "내 지식 저장소의 파일 내용을 읽는다. (소유자 전용)",
      { path: z.string().describe("저장소 루트 기준 상대 경로 (예: skills/foo/SKILL.md)") },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const c = repoCtx();
        if (!c) {
          return text(NO_REPO, true);
        }
        try {
          const repoRoot = await ensureClone(c);
          const content = await readRepoFile(repoRoot, args.path);
          return text(content);
        } catch (error) {
          const detail = scrubGitError(error);
          if (detail === "INVALID_PATH") return text("잘못된 경로입니다.", true);
          if (detail === "FILE_TOO_LARGE") return text("파일이 너무 큽니다.", true);
          if (detail === "NOT_A_FILE") return text("파일이 아닙니다.", true);
          return text(`파일을 읽지 못했습니다: ${detail}`, true);
        }
      },
    ),
    tool(
      "write_file",
      "내 지식 저장소의 파일을 작성/수정한다(없으면 새로 만든다). 변경은 작업 트리에만 반영되며, **commit 도구로 커밋·푸시하기 전까지는 임시 저장**이라 다음 동기화 때 사라질 수 있다. (소유자 전용)",
      {
        path: z.string().describe("저장소 루트 기준 상대 경로"),
        content: z.string().describe("파일 전체 내용"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const c = repoCtx();
        if (!c) {
          return text(NO_REPO, true);
        }
        try {
          const repoRoot = await ensureClone(c);
          await writeRepoFile(repoRoot, args.path, args.content);
          return text(
            `${args.path} 파일을 저장했습니다. (아직 커밋되지 않았습니다 — commit 도구로 푸시하세요.)`,
          );
        } catch (error) {
          const detail = scrubGitError(error);
          if (detail === "INVALID_PATH") return text("잘못된 경로입니다.", true);
          if (detail === "FILE_TOO_LARGE") return text("내용이 너무 큽니다.", true);
          return text(`파일을 저장하지 못했습니다: ${detail}`, true);
        }
      },
    ),
    tool(
      "scaffold_skill",
      "내 지식 저장소에 새 스킬(skills/<이름>/SKILL.md + marketplace 등록)을 만든다. 생성 후 write_file로 내용을 채우고 commit으로 푸시하면 다음 대화부터 아바타가 그 스킬을 쓸 수 있다. (소유자 전용)",
      {
        name: z.string().describe("스킬 이름 (예: deploy-runbook)"),
        description: z.string().optional().describe("스킬 한 줄 설명"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const c = repoCtx();
        if (!c) {
          return text(NO_REPO, true);
        }
        try {
          const repoRoot = await ensureClone(c);
          const filePath = await scaffoldSkill(repoRoot, args.name, args.description ?? "");
          return text(
            `새 스킬을 만들었습니다: ${filePath} (write_file로 내용을 채운 뒤 commit으로 푸시하세요.)`,
          );
        } catch (error) {
          const detail = scrubGitError(error);
          if (detail === "SKILL_EXISTS") return text("같은 이름의 스킬이 이미 있습니다.", true);
          if (detail === "INVALID_PATH") return text("잘못된 경로입니다.", true);
          return text(`스킬을 만들지 못했습니다: ${detail}`, true);
        }
      },
    ),
    tool(
      "commit",
      "내 지식 저장소의 모든 변경사항을 커밋하고 원격(branch)에 푸시한다. 작업 단위가 끝났거나 소유자가 요청하면 호출한다. (소유자 전용)",
      { message: z.string().describe("커밋 메시지") },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const c = repoCtx();
        if (!c) {
          return text(NO_REPO, true);
        }
        if (!c.token) {
          return text("푸시하려면 먼저 설정에서 GitHub 토큰을 등록해 주세요.", true);
        }
        try {
          // No ensureClone here: commitAndPush operates on the already-synced
          // working tree (write_file/scaffold_skill cloned it) and guards with
          // its own NOT_CLONED check. Re-syncing would only add a needless fetch.
          const committed = await commitAndPush(c, args.message, commitIdentityFor(store, ctx.owner));
          if (!committed) {
            return text("커밋할 변경사항이 없습니다.");
          }
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "knowledge_repo_push",
            status: "success",
            detail: `pushed to ${c.repo}`,
          });
          return text(`변경사항을 커밋하고 푸시했습니다: ${c.repo}`);
        } catch (error) {
          return text(`커밋/푸시 실패: ${scrubGitError(error)}`, true);
        }
      },
    ),
  ];
}

/**
 * Build the in-process MCP server exposing the knowledge-repo management tools,
 * bound to a single conversation's store + context.
 */
export function buildRepoServer(store: Store, ctx: RepoToolsContext) {
  return createSdkMcpServer({
    name: REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildRepoTools(store, ctx),
  });
}
