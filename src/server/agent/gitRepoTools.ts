import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig } from "../types.js";
import { scrubGitError } from "../marketplace.js";
import { commitIdentityFor } from "../knowledgeRepo.js";
import {
  commitGitRepo,
  defaultGitRepoName,
  deleteGitRepoFile,
  ensureGitRepoClone,
  gitRepoContextFor,
  gitRepoContextFromRecord,
  gitRepoDiff,
  gitRepoStatus,
  listGitRepoTree,
  normalizeGitRepoName,
  pushGitRepo,
  readGitRepoFile,
  removeGitRepoClone,
  writeGitRepoFile,
} from "../gitRepos.js";

export interface GitRepoToolsContext {
  /** The avatar owner whose registered repos and git tokens are used. */
  avatarUserId: string;
  owner: { id: string; username: string; displayName: string; alias?: string };
  /** True only for the avatar owner in an interactive chat. */
  viewerIsOwner: boolean;
  /** True for owner/trusted-user interactive chats. */
  elevated: boolean;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__git_repo__<tool>`. */
export const GIT_REPO_SERVER_NAME = "git_repo";

/** Tool names the model may call, in `allowedTools` form. */
export const GIT_REPO_TOOL_NAMES = [
  "mcp__git_repo__register_repo",
  "mcp__git_repo__list_repos",
  "mcp__git_repo__sync_repo",
  "mcp__git_repo__remove_repo",
  "mcp__git_repo__status",
  "mcp__git_repo__list_files",
  "mcp__git_repo__read_file",
  "mcp__git_repo__write_file",
  "mcp__git_repo__delete_file",
  "mcp__git_repo__diff",
  "mcp__git_repo__commit",
  "mcp__git_repo__push",
] as const;

const OWNER_ONLY = "이 도구는 아바타 소유자가 참여 중인 대화에서만 사용할 수 있습니다.";
const ELEVATED_ONLY = "이 git repo 도구는 아바타 소유자 또는 신뢰 사용자 대화에서만 사용할 수 있습니다.";

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function errorMessage(error: unknown): string {
  const err = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
  const parts = [err.stderr, err.stdout, err.message]
    .map((part) => (Buffer.isBuffer(part) ? part.toString("utf8") : part))
    .filter((part): part is string => Boolean(part?.trim()));
  return scrubGitError(parts.join("\n").trim() || String(error));
}

function renderRepo(repo: ReturnType<Store["listGitRepos"]>[number]): string {
  return [
    `name=${repo.name}`,
    `repo=${repo.repo}`,
    repo.branch ? `branch=${repo.branch}` : "branch=(default)",
    repo.lastSyncedAt ? `lastSyncedAt=${repo.lastSyncedAt}` : "lastSyncedAt=null",
  ].join(" | ");
}

function renderStatus(status: Awaited<ReturnType<typeof gitRepoStatus>>): string {
  if (!status.cloned) {
    return [
      `name=${status.name}`,
      `repo=${status.repo}`,
      status.branch ? `branch=${status.branch}` : "branch=(default)",
      "cloned=false",
      "sync_repo로 먼저 clone/sync 하세요.",
    ].join(" | ");
  }
  const aheadBehind =
    status.ahead === null || status.behind === null
      ? "upstream=(unknown)"
      : `ahead=${status.ahead} behind=${status.behind}`;
  const dirty = status.dirty.length ? status.dirty.join(", ") : "(clean)";
  return [
    `name=${status.name}`,
    `repo=${status.repo}`,
    `branch=${status.branch ?? "(detached)"}`,
    `head=${status.head ?? "(unknown)"}`,
    aheadBehind,
    `dirty=${dirty}`,
  ].join(" | ");
}

/**
 * Build general git repository tools. Persistent repo registration is
 * owner-only; work on already-registered repos is owner/trusted-only.
 */
export function buildGitRepoTools(store: Store, ctx: GitRepoToolsContext) {
  const ownerRepoContext = (name: string) => {
    const repoCtx = gitRepoContextFor(store, ctx.avatarUserId, name, ctx.config);
    if (!repoCtx) {
      throw new Error(`등록된 git repo '${normalizeGitRepoName(name)}'을(를) 찾을 수 없습니다. 먼저 register_repo를 사용하세요.`);
    }
    return repoCtx;
  };

  const elevatedGuard = () => {
    if (!ctx.elevated) {
      return text(ELEVATED_ONLY, true);
    }
    return null;
  };
  const ownerGuard = () => {
    if (!ctx.viewerIsOwner) {
      return text(OWNER_ONLY, true);
    }
    return null;
  };

  return [
    tool(
      "register_repo",
      "일반 git 저장소를 이 아바타 소유자의 repo 목록에 등록하고 로컬 작업 복제본을 만든다. repo는 owner/repo, https URL, git URL, 로컬 bare repo 경로를 받을 수 있다. branch를 지정하면 이후 sync/commit/push가 그 브랜치를 대상으로 동작하고, 비우면 저장소 기본 브랜치를 사용한다. public repo clone/sync는 토큰 없이 시도하고, 토큰은 설정된 사내 host 또는 github.com에만 있으면 사용한다. (소유자 전용)",
      {
        repo: z.string().describe("등록할 git 저장소. 예: owner/repo, https://github.com/owner/repo.git, /path/to/repo.git"),
        name: z.string().optional().describe("대화에서 사용할 짧은 이름. 비우면 repo 이름에서 자동 생성한다."),
        branch: z.string().optional().describe("사용할 브랜치. main 전용이 아니며, 비우면 저장소 기본 브랜치를 사용한다."),
      },
      async (args) => {
        const denied = ownerGuard();
        if (denied) return denied;
        const name = normalizeGitRepoName(args.name || defaultGitRepoName(args.repo));
        // Track whether this name was already registered: on a failed clone we roll
        // back a NEWLY-created row (so a typo'd repo doesn't linger in list_repos),
        // but must leave a pre-existing registration intact.
        const existed = Boolean(store.getGitRepo(ctx.avatarUserId, name));
        try {
          const record = store.upsertGitRepo(ctx.avatarUserId, name, args.repo, args.branch || null);
          const repoCtx = gitRepoContextFromRecord(store, record, ctx.config);
          await ensureGitRepoClone(repoCtx, { sync: true });
          store.markGitRepoSynced(ctx.avatarUserId, name);
          return text(`git repo를 등록하고 sync했습니다: ${renderRepo(store.getGitRepo(ctx.avatarUserId, name)!)}.`);
        } catch (error) {
          if (!existed) store.deleteGitRepo(ctx.avatarUserId, name);
          return text(`git repo 등록/sync 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "list_repos",
      "이 아바타 소유자에게 등록된 일반 git 저장소 목록을 조회한다. (소유자/신뢰 사용자 전용)",
      {},
      async () => {
        const denied = elevatedGuard();
        if (denied) return denied;
        const repos = store.listGitRepos(ctx.avatarUserId);
        if (repos.length === 0) {
          return text("등록된 일반 git repo가 없습니다. 소유자가 register_repo로 먼저 등록해야 합니다.");
        }
        return text(`등록된 git repo ${repos.length}개:\n${repos.map(renderRepo).join("\n")}`);
      },
    ),
    tool(
      "sync_repo",
      "등록된 git 저장소를 fetch 후 fast-forward로 최신화한다. public repo는 토큰 없이 fetch/pull을 시도하며, 미커밋 변경이나 충돌이 있으면 실패한다. (소유자/신뢰 사용자 전용)",
      { name: z.string().describe("등록된 repo 이름") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          await ensureGitRepoClone(repoCtx, { sync: true });
          store.markGitRepoSynced(ctx.avatarUserId, repoCtx.name);
          return text(`git repo를 sync했습니다: ${repoCtx.name}`);
        } catch (error) {
          return text(`sync 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "remove_repo",
      "등록된 일반 git 저장소를 목록에서 제거하고 로컬 작업 복제본도 삭제한다. 원격 저장소는 삭제하지 않는다. (소유자 전용)",
      { name: z.string().describe("등록된 repo 이름") },
      async (args) => {
        const denied = ownerGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const removed = store.deleteGitRepo(ctx.avatarUserId, repoCtx.name);
          await removeGitRepoClone(repoCtx);
          return text(removed ? `git repo 등록을 제거했습니다: ${repoCtx.name}` : `등록된 git repo가 없습니다: ${repoCtx.name}`);
        } catch (error) {
          return text(`repo 제거 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "status",
      "등록된 git 저장소의 현재 브랜치, HEAD, ahead/behind, 미커밋 변경 파일을 조회한다. (소유자/신뢰 사용자 전용)",
      { name: z.string().describe("등록된 repo 이름") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          return text(renderStatus(await gitRepoStatus(ownerRepoContext(args.name))));
        } catch (error) {
          return text(`status 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "list_files",
      "등록된 git 저장소의 파일 트리를 나열한다. `.git`은 제외된다. (소유자/신뢰 사용자 전용)",
      { name: z.string().describe("등록된 repo 이름") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const entries = await listGitRepoTree(ownerRepoContext(args.name));
          if (entries.length === 0) return text("저장소가 비어 있습니다.");
          return text(entries.map((e) => `${e.type === "dir" ? "dir " : "file"} ${e.path}`).join("\n"));
        } catch (error) {
          return text(`파일 목록 조회 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "read_file",
      "등록된 git 저장소의 텍스트 파일을 읽는다. (소유자/신뢰 사용자 전용)",
      {
        name: z.string().describe("등록된 repo 이름"),
        path: z.string().describe("repo 루트 기준 상대 경로"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          return text(await readGitRepoFile(ownerRepoContext(args.name), args.path));
        } catch (error) {
          return text(`파일 읽기 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "write_file",
      "등록된 git 저장소의 텍스트 파일을 작성/수정한다. 변경은 로컬 작업트리에만 반영되며 commit/push 전까지 원격에 반영되지 않는다. (소유자/신뢰 사용자 전용)",
      {
        name: z.string().describe("등록된 repo 이름"),
        path: z.string().describe("repo 루트 기준 상대 경로"),
        content: z.string().describe("파일 전체 내용"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          await writeGitRepoFile(ownerRepoContext(args.name), args.path, args.content);
          return text(`파일을 저장했습니다: ${args.path}\n아직 커밋/푸시되지 않았습니다. 필요하면 diff 후 commit/push 하세요.`);
        } catch (error) {
          return text(`파일 쓰기 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "delete_file",
      "등록된 git 저장소의 파일을 삭제한다. 삭제는 로컬 작업트리에만 반영된다. (소유자/신뢰 사용자 전용)",
      {
        name: z.string().describe("등록된 repo 이름"),
        path: z.string().describe("repo 루트 기준 상대 경로"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          await deleteGitRepoFile(ownerRepoContext(args.name), args.path);
          return text(`파일을 삭제했습니다: ${args.path}\n아직 커밋/푸시되지 않았습니다.`);
        } catch (error) {
          return text(`파일 삭제 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "diff",
      "등록된 git 저장소의 unstaged diff를 조회한다. paths를 주면 해당 경로로 제한한다. (소유자/신뢰 사용자 전용)",
      {
        name: z.string().describe("등록된 repo 이름"),
        paths: z.array(z.string()).optional().describe("선택 경로 목록"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const diff = await gitRepoDiff(ownerRepoContext(args.name), args.paths);
          return text(diff.trim() ? diff : "변경 diff가 없습니다. 새 untracked 파일은 commit 전 status에서 확인하세요.");
        } catch (error) {
          return text(`diff 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "commit",
      "등록된 git 저장소의 변경사항을 커밋한다. paths를 주면 해당 경로만 stage한다. push는 별도 push 도구로 수행한다. (소유자/신뢰 사용자 전용)",
      {
        name: z.string().describe("등록된 repo 이름"),
        message: z.string().describe("커밋 메시지"),
        paths: z.array(z.string()).optional().describe("선택 경로 목록"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const committed = await commitGitRepo(repoCtx, args.message, commitIdentityFor(store, ctx.owner), args.paths);
          return text(committed ? `변경사항을 커밋했습니다: ${repoCtx.name}` : "커밋할 변경사항이 없습니다.");
        } catch (error) {
          return text(`commit 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "push",
      "등록된 git 저장소의 현재 HEAD를 origin의 대상 브랜치로 push한다. 대상은 register_repo에 저장된 branch이며, branch가 비어 있으면 현재/default branch다. main 전용이 아니다. (소유자/신뢰 사용자 전용)",
      { name: z.string().describe("등록된 repo 이름") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const branch = await pushGitRepo(repoCtx);
          return text(`변경사항을 push했습니다: ${repoCtx.name} -> ${branch}`);
        } catch (error) {
          return text(`push 실패: ${errorMessage(error)}`, true);
        }
      },
    ),
  ];
}

export function buildGitRepoServer(store: Store, ctx: GitRepoToolsContext) {
  return createSdkMcpServer({
    name: GIT_REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildGitRepoTools(store, ctx),
  });
}
