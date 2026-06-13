import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig, UserGroupMembership } from "../types.js";
import { normalizeGithubHost, scrubGitError } from "../marketplace.js";
import {
  commitIdentityFor,
  listTree,
  readFile as readRepoFile,
  scaffoldSkill,
  writeFile as writeRepoFile,
  writeRepoTemplate,
} from "../knowledgeRepo.js";
import {
  ensureGroupClone,
  groupCommitAndPush,
  groupKnowledgeRepoContextFor,
} from "../groupKnowledgeRepo.js";
import { createRemoteRepo } from "./repoTools.js";

/**
 * Per-conversation context the group knowledge-repo tools act within. These let
 * the avatar manage the SHARED knowledge repos of the groups its OWNER belongs
 * to, from chat. They are OWNER-ONLY (a colleague/trusted teammate or a headless
 * routine gets a refusal): a group admin edits their group repo through their
 * OWN avatar. Per-tool the OWNER's role in the named group is then checked —
 * members may read, only group admins may write/commit/create.
 */
export interface GroupRepoToolsContext {
  /** The avatar (== owner) whose group memberships these tools act on. */
  avatarUserId: string;
  owner: { id: string; username: string; displayName: string; alias?: string };
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__group_repo__<tool>`. */
export const GROUP_REPO_SERVER_NAME = "group_repo";

/** Tool names the model may call, in `allowedTools` form. */
export const GROUP_REPO_TOOL_NAMES = [
  "mcp__group_repo__list_groups",
  "mcp__group_repo__list_files",
  "mcp__group_repo__read_file",
  "mcp__group_repo__write_file",
  "mcp__group_repo__scaffold_skill",
  "mcp__group_repo__commit",
  "mcp__group_repo__create_repo",
] as const;

const OWNER_ONLY = "이 도구는 아바타 소유자만 사용할 수 있습니다.";
const NO_SUCH_GROUP =
  "그런 이름/ID의 그룹을 찾을 수 없습니다. 먼저 list_groups로 내가 속한 그룹을 확인하세요.";
const ADMIN_ONLY =
  "이 그룹의 공용 지식 저장소는 그룹 관리자만 수정할 수 있습니다. (멤버는 읽기만 가능합니다.)";
const NO_REPO =
  "이 그룹에는 아직 공용 지식 저장소가 연결되어 있지 않습니다. 그룹 관리자라면 `create_repo`로 새로 만들거나, 설정의 그룹 관리에서 기존 저장소를 연결하세요.";

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function githubHostDescription(host: string): string {
  const normalized = normalizeGithubHost(host);
  return `현재 GitHub host는 \`${normalized}\`이고, create_repo는 \`GH_HOST=${normalized} gh repo create\`로 생성한다.`;
}

/**
 * Build the group knowledge-repo management tools bound to one conversation's
 * store + context. Exposed separately from the server so handlers can be tested
 * directly. Owner-only + per-group-role gating is enforced in the handlers.
 */
export function buildGroupRepoTools(
  store: Store,
  ctx: GroupRepoToolsContext,
  opts: { createRemoteRepo?: typeof createRemoteRepo } = {},
) {
  const create = opts.createRemoteRepo ?? createRemoteRepo;

  /** The owner's groups (id/name/role/repo flag). */
  const ownerGroups = (): UserGroupMembership[] => store.listUserGroups(ctx.avatarUserId);

  /** Resolve a `group` argument (id or name, case-insensitive) among the owner's groups. */
  const resolveGroup = (arg: string): UserGroupMembership | null => {
    const a = arg.trim().toLowerCase();
    if (!a) return null;
    const groups = ownerGroups();
    return (
      groups.find((g) => g.id.toLowerCase() === a) ??
      groups.find((g) => g.name.toLowerCase() === a) ??
      null
    );
  };

  const repoCtx = (groupId: string, groupName?: string) =>
    groupKnowledgeRepoContextFor(store, groupId, ctx.avatarUserId, ctx.config, groupName);

  return [
    tool(
      "list_groups",
      "내가 속한 그룹 목록과 각 그룹에서의 내 역할(admin/member), 공용 지식 저장소 연결 여부를 조회한다. 그룹 지식 저장소 작업 전에 먼저 호출해 그룹 이름을 확인한다. (소유자 전용)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const groups = ownerGroups();
        if (groups.length === 0) {
          return text("속한 그룹이 없습니다. 그룹은 시스템 관리자가 만들고 멤버를 추가합니다.");
        }
        const body = groups
          .map(
            (g) =>
              `- ${g.name} (역할: ${g.role === "admin" ? "관리자" : "멤버"}, 공용 저장소: ${
                g.knowledgeRepoConfigured ? "연결됨" : "없음"
              })`,
          )
          .join("\n");
        return text(`내가 속한 그룹 ${groups.length}개:\n${body}`);
      },
    ),
    tool(
      "list_files",
      "지정한 그룹의 공용 지식 저장소 파일 목록을 가져온다. (그룹 멤버 전용)",
      { group: z.string().describe("그룹 이름 또는 ID (list_groups로 확인)") },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        try {
          const repoRoot = await ensureGroupClone(c);
          const entries = await listTree(repoRoot);
          if (entries.length === 0) return text("(빈 저장소입니다.)");
          const list = entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n");
          return text(`'${group.name}' 그룹 지식 저장소 파일 목록:\n${list}`);
        } catch (error) {
          return text(
            `저장소를 불러오지 못했습니다: ${scrubGitError(error)}\n저장소 주소/브랜치와 토큰 권한을 확인하세요. Bash git으로 직접 clone하지 마세요 — 셸에는 git 자격증명이 없습니다.`,
            true,
          );
        }
      },
    ),
    tool(
      "read_file",
      "지정한 그룹의 공용 지식 저장소에서 파일 내용을 읽는다. (그룹 멤버 전용)",
      {
        group: z.string().describe("그룹 이름 또는 ID"),
        path: z.string().describe("저장소 루트 기준 상대 경로 (예: skills/foo/SKILL.md)"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        try {
          const repoRoot = await ensureGroupClone(c);
          return text(await readRepoFile(repoRoot, args.path));
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
      "지정한 그룹의 공용 지식 저장소 파일을 작성/수정한다(없으면 새로 만든다). 변경은 작업 트리에만 반영되며 **commit 전까지는 임시 저장**이다. (그룹 관리자 전용)",
      {
        group: z.string().describe("그룹 이름 또는 ID"),
        path: z.string().describe("저장소 루트 기준 상대 경로"),
        content: z.string().describe("파일 전체 내용"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        try {
          const repoRoot = await ensureGroupClone(c);
          await writeRepoFile(repoRoot, args.path, args.content);
          return text(`${args.path} 파일을 저장했습니다. (아직 커밋되지 않았습니다 — commit으로 푸시하세요.)`);
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
      "지정한 그룹의 공용 지식 저장소에 새 스킬(skills/<이름>/SKILL.md + marketplace 등록)을 만든다. 이후 write_file로 채우고 commit으로 푸시하면 그룹 멤버 전원의 아바타가 그 스킬을 쓸 수 있다. (그룹 관리자 전용)",
      {
        group: z.string().describe("그룹 이름 또는 ID"),
        name: z.string().describe("스킬 이름 (예: team-runbook)"),
        description: z.string().optional().describe("스킬 한 줄 설명"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        try {
          const repoRoot = await ensureGroupClone(c);
          const filePath = await scaffoldSkill(repoRoot, args.name, args.description ?? "");
          return text(`새 스킬을 만들었습니다: ${filePath} (write_file로 내용을 채운 뒤 commit으로 푸시하세요.)`);
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
      "지정한 그룹의 공용 지식 저장소 변경사항을 커밋하고 원격에 푸시한다. 작업 단위가 끝나면 호출한다. (그룹 관리자 전용)",
      {
        group: z.string().describe("그룹 이름 또는 ID"),
        message: z.string().describe("커밋 메시지"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        if (!c.token) {
          return text("푸시하려면 먼저 설정에서 사내 Git 토큰(GIT_TOKEN)을 등록해 주세요.", true);
        }
        try {
          const committed = await groupCommitAndPush(c, args.message, commitIdentityFor(store, ctx.owner));
          if (!committed) return text("커밋할 변경사항이 없습니다.");
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "group_repo_push",
            status: "success",
            detail: `group=${group.name} pushed to ${c.repo}`,
          });
          return text(`'${group.name}' 그룹 지식 저장소에 변경사항을 커밋·푸시했습니다: ${c.repo}`);
        } catch (error) {
          return text(
            `커밋/푸시 실패: ${scrubGitError(error)}\n토큰(GIT_TOKEN)의 쓰기 권한과 원격 브랜치 보호 설정을 확인하세요. Bash \`git push\`로 우회하지 마세요 — 셸에는 git 자격증명이 없습니다.`,
            true,
          );
        }
      },
    ),
    tool(
      "create_repo",
      `**그룹 관리자가 그룹 공용 지식 저장소를 만들어 달라고 하면 이 도구를 사용한다.** ${githubHostDescription(
        ctx.config.githubHost,
      )} 설정된 사내 Git 토큰(GIT_TOKEN)으로 새 사내 GitHub 저장소(기본 비공개, Claude plugin marketplace 템플릿으로 초기화)를 만들고 해당 그룹에 곧바로 연결한다. 그룹에 저장소가 아직 없을 때만 동작한다. (그룹 관리자 전용)`,
      {
        group: z.string().describe("그룹 이름 또는 ID"),
        name: z.string().describe("새 저장소 이름 (영문/숫자와 - _ . 만, 예: team-knowledge)"),
        private: z.boolean().optional().describe("비공개 여부 (기본 true)"),
        description: z.string().optional().describe("저장소 설명 (선택)"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        if (group.knowledgeRepoConfigured) {
          return text("이 그룹에는 이미 공용 지식 저장소가 연결되어 있습니다.", true);
        }
        const token = store.getGitToken(ctx.avatarUserId);
        if (!token) {
          return text(
            "GitHub 저장소를 만들려면 먼저 설정 → Git 자격증명에 사내 Git 토큰(GIT_TOKEN)을 등록해 주세요.",
            true,
          );
        }
        const name = args.name.trim();
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
          return text("저장소 이름은 영문/숫자와 - _ . 문자만 사용할 수 있습니다.", true);
        }
        const targetHost = normalizeGithubHost(ctx.config.githubHost);
        try {
          const result = await create(
            targetHost,
            token,
            name,
            args.private ?? true,
            (args.description ?? "").trim(),
            ctx.config.githubCaCert,
          );
          if (!result.ok) {
            const status = result.status ? `, HTTP ${result.status}` : "";
            const exitCode = result.exitCode ? `, exit ${result.exitCode}` : "";
            return text(
              `GitHub 저장소 생성 실패 (host: ${targetHost}${status}${exitCode}): ${result.message}\n토큰(GIT_TOKEN)에 repo 생성 권한이 있는지, 같은 이름의 저장소가 이미 있는지 확인하세요. Bash \`gh\`/git으로 우회하지 마세요 — 셸에는 git 자격증명이 없습니다.`,
              true,
            );
          }
          store.setGroupKnowledgeRepo(group.id, result.fullName, result.defaultBranch);
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "group_repo_create",
            status: "success",
            detail: `group=${group.name} created ${result.fullName}`,
          });
          let seeded = false;
          let seedNote = "";
          try {
            const c = repoCtx(group.id, group.name);
            if (c) {
              const repoRoot = await ensureGroupClone(c);
              if (await writeRepoTemplate(repoRoot, result.fullName)) {
                await groupCommitAndPush(c, "Initialize group knowledge repo", commitIdentityFor(store, ctx.owner));
                seeded = true;
              }
            }
          } catch (error) {
            seedNote = ` (기본 템플릿 초기화는 건너뛰었습니다: ${scrubGitError(error)})`;
          }
          const kind = result.isPrivate ? "비공개" : "공개";
          return text(
            seeded
              ? `'${group.name}' 그룹의 ${kind} 공용 지식 저장소 \`${result.fullName}\`를 만들고 기본 템플릿으로 초기화했습니다. 이제 scaffold_skill로 첫 스킬을 추가하고 commit으로 푸시하세요.`
              : `'${group.name}' 그룹의 ${kind} 공용 지식 저장소 \`${result.fullName}\`를 만들고 연결했습니다.${seedNote}`,
          );
        } catch (error) {
          return text(`GitHub 저장소 생성 중 오류 (host: ${targetHost}): ${scrubGitError(error)}`, true);
        }
      },
    ),
  ];
}

/** Build the in-process MCP server exposing the group knowledge-repo tools. */
export function buildGroupRepoServer(store: Store, ctx: GroupRepoToolsContext) {
  return createSdkMcpServer({
    name: GROUP_REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildGroupRepoTools(store, ctx),
  });
}
