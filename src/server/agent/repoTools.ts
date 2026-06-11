import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig } from "../types.js";
import { DEFAULT_GITHUB_HOST, scrubGitError } from "../marketplace.js";
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
  owner: { id: string; username: string; displayName: string; alias?: string };
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

/**
 * The repo-creation tool name. Surfaced separately because it's exposed ONLY
 * when the owner has NO knowledge repo yet — once one is connected, hiding it
 * keeps the (rarely-needed) tool out of the prompt to save tokens.
 */
export const REPO_CREATE_TOOL_NAME = "mcp__repo__create_repo";

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

type CreateRepoResult =
  | { ok: true; fullName: string; defaultBranch: string; isPrivate: boolean }
  | { ok: false; status: number; message: string };

/**
 * Create a new repo under the token owner's account via the GitHub REST API
 * (`POST /user/repos`), with `auto_init` so it has a default branch to clone and
 * push to immediately. The token never leaves this process; the API base honors
 * a self-hosted `GITHUB_HOST` (`/api/v3`). Returns a discriminated result so the
 * caller can surface the HTTP status/message without echoing the token.
 */
async function createRemoteRepo(
  host: string,
  token: string,
  name: string,
  isPrivate: boolean,
  description: string,
): Promise<CreateRepoResult> {
  const apiBase = host === DEFAULT_GITHUB_HOST ? "https://api.github.com" : `https://${host}/api/v3`;
  const res = await fetch(`${apiBase}/user/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "noah-almighty",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      private: isPrivate,
      auto_init: true,
      ...(description ? { description } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof body.message === "string" ? body.message : res.statusText || "unknown error";
    return { ok: false, status: res.status, message };
  }
  return {
    ok: true,
    fullName: typeof body.full_name === "string" ? body.full_name : name,
    defaultBranch: typeof body.default_branch === "string" ? body.default_branch : "main",
    isPrivate: Boolean(body.private),
  };
}

const OWNER_ONLY = "이 도구는 아바타 소유자만 사용할 수 있습니다.";
const NO_REPO =
  "지식 저장소가 설정되지 않았습니다. GitHub에 Claude plugin marketplace 형식의 개인 지식 저장소를 만들거나 기존 repo를 설정에서 먼저 연결해 주세요.";

/**
 * Build the knowledge-repo management tool definitions bound to a single
 * conversation's store + context. Exposed separately from the server so the
 * handlers can be exercised directly in tests. Owner-only gating is enforced
 * here (the model can call them, but a non-owner gets a refusal result).
 */
export function buildRepoTools(
  store: Store,
  ctx: RepoToolsContext,
  opts: { allowCreate?: boolean } = {},
) {
  // Resolve the repo context fresh on each call so a token/repo change mid-
  // conversation is picked up. Returns null when no repo is configured.
  const repoCtx = () => knowledgeRepoContextFor(store, ctx.avatarUserId, ctx.config);

  const manageTools = [
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

  // Only meaningful (and only exposed) when no repo is connected yet. Once one
  // exists, the caller passes allowCreate=false so this tool stays out of the
  // prompt — the manage tools above are what an established repo needs.
  if (!opts.allowCreate) {
    return manageTools;
  }
  const createTool = tool(
    "create_repo",
    "설정된 git 토큰으로 새 GitHub 지식 저장소(기본 비공개)를 만들고 곧바로 연결한다. 지식 저장소가 아직 없을 때만 쓸 수 있다. 생성 후 scaffold_skill→write_file→commit으로 내용을 채운다. (소유자 전용)",
    {
      name: z.string().describe("새 저장소 이름 (영문/숫자와 - _ . 만, 예: my-knowledge)"),
      private: z.boolean().optional().describe("비공개 여부 (기본 true)"),
      description: z.string().optional().describe("저장소 설명 (선택)"),
    },
    async (args) => {
      if (!ctx.viewerIsOwner) {
        return text(OWNER_ONLY, true);
      }
      if (repoCtx()) {
        return text("이미 지식 저장소가 연결되어 있습니다. 새로 만들 필요가 없습니다.", true);
      }
      const token = store.getGitToken(ctx.avatarUserId);
      if (!token) {
        return text(
          "GitHub 저장소를 만들려면 먼저 설정 → git 자격증명에 토큰을 등록해 주세요. (repo 생성 권한이 있는 토큰이 필요합니다.)",
          true,
        );
      }
      const name = args.name.trim();
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
        return text("저장소 이름은 영문/숫자와 - _ . 문자만 사용할 수 있습니다.", true);
      }
      try {
        const result = await createRemoteRepo(
          ctx.config.githubHost,
          token,
          name,
          args.private ?? true,
          (args.description ?? "").trim(),
        );
        if (!result.ok) {
          return text(`GitHub 저장소 생성 실패 (HTTP ${result.status}): ${result.message}`, true);
        }
        store.setKnowledgeRepo(ctx.avatarUserId, result.fullName, result.defaultBranch);
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "knowledge_repo_create",
          status: "success",
          detail: `created ${result.fullName}`,
        });
        return text(
          `${result.isPrivate ? "비공개" : "공개"} 지식 저장소 \`${result.fullName}\`를 만들고 연결했습니다. ` +
            "이제 `scaffold_skill`로 첫 스킬을 만든 뒤 `write_file`로 내용을 채우고 `commit`으로 푸시하세요.",
        );
      } catch (error) {
        return text(`GitHub 저장소 생성 중 오류: ${scrubGitError(error)}`, true);
      }
    },
  );
  return [createTool, ...manageTools];
}

/**
 * Build the in-process MCP server exposing the knowledge-repo management tools,
 * bound to a single conversation's store + context. `allowCreate` adds the
 * repo-creation tool (only when the owner has no repo yet — see its export doc).
 */
export function buildRepoServer(
  store: Store,
  ctx: RepoToolsContext,
  opts: { allowCreate?: boolean } = {},
) {
  return createSdkMcpServer({
    name: REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildRepoTools(store, ctx, opts),
  });
}
