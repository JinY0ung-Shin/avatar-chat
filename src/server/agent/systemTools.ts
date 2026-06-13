import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig, Plugin, RoutineJob } from "../types.js";

/**
 * Per-conversation context for avatar-system management tools. These tools let
 * the avatar inspect and change its own platform settings, but only when the
 * avatar owner is present or an owner-scheduled routine is running with owner
 * tool access.
 */
export interface SystemToolsContext {
  /** The avatar (== owner) whose settings these tools manage. */
  avatarUserId: string;
  /** The avatar owner, used for audit attribution. */
  owner: { id: string; username: string; displayName: string; alias?: string };
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__system__<tool>`. */
export const SYSTEM_SERVER_NAME = "system";

/** Tool names the model may call, in `allowedTools` form. */
export const SYSTEM_TOOL_NAMES = [
  "mcp__system__describe_system",
  "mcp__system__notify_user",
  "mcp__system__list_routines",
  "mcp__system__create_routine",
  "mcp__system__update_routine",
  "mcp__system__delete_routine",
  "mcp__system__list_plugins",
  "mcp__system__add_plugin",
  "mcp__system__set_plugin_enabled",
] as const;

const OWNER_ONLY = "이 도구는 아바타 소유자가 참여 중인 대화에서만 사용할 수 있습니다.";

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function parseTimeToMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

function looksLikeRepo(value: string): boolean {
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return true;
  }
  return /^https?:\/\//.test(value) || /^git@/.test(value) || value.endsWith(".git");
}

function renderRoutine(job: RoutineJob): string {
  return [
    `id=${job.id}`,
    `time=${job.time} KST`,
    `enabled=${job.enabled ? "true" : "false"}`,
    `prompt=${JSON.stringify(job.prompt)}`,
    job.nextRunAt ? `nextRunAt=${job.nextRunAt}` : "nextRunAt=null",
    job.lastStatus ? `lastStatus=${job.lastStatus}` : "lastStatus=null",
  ].join(" | ");
}

function renderPlugin(plugin: Plugin): string {
  return [
    `id=${plugin.id}`,
    `repo=${plugin.repo}`,
    plugin.label ? `label=${JSON.stringify(plugin.label)}` : "label=null",
    plugin.ref ? `ref=${plugin.ref}` : "ref=null",
    `enabled=${plugin.enabled ? "true" : "false"}`,
    plugin.lastSyncedAt ? `lastSyncedAt=${plugin.lastSyncedAt}` : "lastSyncedAt=null",
  ].join(" | ");
}

function actor(ctx: SystemToolsContext) {
  return {
    actorUserId: ctx.owner.id,
    actorName: ctx.owner.username,
  };
}

/**
 * Build system-management tool definitions bound to a single conversation.
 * Handler-level owner gating is the safety boundary; the SDK may see the tool
 * names, but non-owner/headless calls get a refusal result.
 */
export function buildSystemTools(store: Store, ctx: SystemToolsContext) {
  return [
    tool(
      "describe_system",
      "현재 아바타 시스템의 구조와 이 아바타가 관리할 수 있는 설정을 요약한다. 소유자에게는 현재 상태(프로필 공개 여부·소개·해시태그, 지식 저장소, 일반 git repo, 그룹과 역할, 시크릿 이름, SSH 활성 여부, 신뢰 사용자, 플러그인, 루틴, 대기 중 정보 요청)를 포함한다. 자신의 설정·상태에 대한 질문을 받으면 추측하지 말고 먼저 이 도구를 호출한다.",
      {},
      async () => {
        const user = store.getUserById(ctx.avatarUserId);
        const publicGuide = [
          "Noah Almighty avatar-chat 시스템 요약:",
          "- 아바타는 프로필/페르소나, 기본 스킬, 소유자 플러그인, 개인 지식 저장소를 함께 로드해 대화합니다.",
          "- 지식 저장소는 아바타가 직접 파일과 스킬을 만들고 커밋할 수 있는 개인 repo입니다.",
          "- 플러그인은 GitHub repo 또는 git URL로 추가되며 다음 대화부터 로드됩니다.",
          "- 루틴은 매일 KST 기준 지정 시간에 headless로 실행되며, 소유자와 같은 도구 권한으로 작업하고 루틴 탭에 결과를 남깁니다.",
          "- 시크릿 값은 노출되지 않고, 이름만 아바타에게 알려집니다.",
          "- git 원격 작업(clone/push 등)은 전용 MCP 도구로만 수행됩니다. 셸에는 git 자격증명이 없습니다.",
        ];
        if (!ctx.viewerIsOwner) {
          return text(
            `${publicGuide.join("\n")}\n\n현재 대화 상대는 소유자가 아니므로 플러그인/루틴/지식 저장소 설정 변경은 할 수 없습니다.`,
          );
        }
        const plugins = store.listPlugins(ctx.avatarUserId);
        const routines = store.listRoutineJobs(ctx.avatarUserId);
        const knowledgeRepo = store.getKnowledgeRepo(ctx.avatarUserId);
        const gitRepos = store.listGitRepos(ctx.avatarUserId);
        const secretNames = store.listUserSecretNames(ctx.avatarUserId);
        const groups = user?.groups ?? store.listUserGroups(ctx.avatarUserId);
        const trustedUsers = store.listTrustedUsers(ctx.avatarUserId);
        const openRequests = store.countOpenKnowledgeRequests(ctx.avatarUserId);
        // Mirrors the runtime's model resolution (claudeAgent: env pin > admin
        // override > SDK default) so the avatar reports the model it ACTUALLY
        // runs with, not just the env value.
        const adminModel = store.getModelOverride();
        const modelLine = ctx.config.anthropicModel
          ? `${ctx.config.anthropicModel} (환경변수 고정)`
          : adminModel
            ? `${adminModel} (관리자 설정)`
            : "(SDK 기본값)";
        const hashtags = user?.hashtags ?? [];
        const lines = [
          ...publicGuide,
          "",
          "현재 아바타 상태:",
          `- 이름: ${user?.alias || user?.displayName || ctx.owner.displayName}`,
          `- 프로필: ${user?.published ? "공개됨(탐색에 노출)" : "비공개(탐색에 숨김)"}, 소개글 ${user?.intro?.trim() ? "설정됨" : "(없음)"}, 역량 해시태그 ${hashtags.length ? hashtags.map((t) => `#${t}`).join(" ") : "(없음)"}`,
          `- runtime: ${ctx.config.agentRuntime}`,
          `- 사용 모델: ${modelLine}`,
          `- maxTurns: ${ctx.config.maxTurns}`,
          `- Confluence host: ${ctx.config.confluenceUrl ? "설정됨" : "(없음)"}`,
          `- Confluence PAT: ${secretNames.includes("CONFLUENCE_PAT") || secretNames.includes("CONFLUENCE_PERSONAL_ACCESS_TOKEN") ? "시크릿 설정됨" : "(없음)"}`,
          `- 지식 저장소: ${knowledgeRepo.repo || "(없음)"}${knowledgeRepo.branch ? ` @ ${knowledgeRepo.branch}` : ""}`,
          `- 일반 git repo: ${gitRepos.length}개`,
          `- 사내 Git 토큰(GIT_TOKEN): ${store.getGitToken(ctx.avatarUserId) ? "설정됨" : "없음"}`,
          `- 시크릿 이름: ${secretNames.length ? secretNames.map((name) => `\`${name}\``).join(", ") : "(없음)"}`,
          `- 원격 SSH 도구: ${secretNames.includes("SSH_PRIVATE_KEY") ? "활성(SSH_PRIVATE_KEY 설정됨)" : "비활성(SSH_PRIVATE_KEY 시크릿 없음)"}`,
          `- 그룹: ${groups.length ? groups.map((g) => `${g.name}(${g.role === "admin" ? "관리자" : "멤버"}, 공용 저장소 ${g.knowledgeRepoConfigured ? "연결됨" : "없음"})`).join(", ") : "(없음)"} — 같은 그룹 멤버끼리는 자동으로 상호 신뢰됩니다.`,
          `- 직접 신뢰 설정한 사용자: ${trustedUsers.length ? trustedUsers.map((t) => `${t.displayName}(@${t.username})`).join(", ") : "(없음)"}`,
          `- 플러그인: ${plugins.length}개 (${plugins.filter((p) => p.enabled).length}개 활성)`,
          `- 루틴: ${routines.length}개 (${routines.filter((r) => r.enabled).length}개 활성)`,
          `- 대기 중 정보 요청: ${openRequests}건${openRequests > 0 ? " (pending_requests로 내용 확인)" : ""}`,
        ];
        return text(lines.join("\n"));
      },
    ),
    tool(
      "notify_user",
      "아바타 소유자에게 앱 내부 알림 메시지를 보낸다. 루틴 실행 중 중요한 결과, 조치 필요 사항, 장애 감지 등을 사용자에게 따로 알릴 때 사용한다. (소유자/소유자 루틴 전용)",
      {
        title: z.string().optional().describe("알림 제목. 비우면 '아바타 알림'"),
        message: z.string().describe("사용자에게 보여줄 알림 본문"),
        conversationId: z.string().optional().describe("관련 대화 ID. 비우면 알림만 남긴다."),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        try {
          const notification = store.addAvatarNotification(ctx.avatarUserId, {
            avatarUserId: ctx.avatarUserId,
            title: args.title,
            message: args.message,
            conversationId: args.conversationId,
          });
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "system_tool_notify_user",
            status: "success",
            detail: `notification ${notification.id}`,
          });
          return text(`알림을 보냈습니다: ${notification.title}`);
        } catch (error) {
          const message = error instanceof Error && error.message === "EMPTY_NOTIFICATION"
            ? "알림 본문을 입력해 주세요."
            : "알림을 저장하지 못했습니다.";
          return text(message, true);
        }
      },
    ),
    tool(
      "list_routines",
      "소유자의 아바타 루틴 목록을 조회한다. 루틴은 매일 KST 시간에 headless로 실행되며 소유자와 같은 도구 권한을 사용한다. (소유자 전용)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const routines = store.listRoutineJobs(ctx.avatarUserId);
        if (routines.length === 0) {
          return text("등록된 루틴이 없습니다.");
        }
        return text(`등록된 루틴 ${routines.length}건:\n${routines.map(renderRoutine).join("\n")}`);
      },
    ),
    tool(
      "create_routine",
      "새 루틴 업무를 만든다. 매일 KST 기준 time(HH:MM)에 prompt를 headless로 실행하고, 소유자와 같은 도구 권한으로 작업한 결과를 루틴 탭에 남긴다. (소유자 전용)",
      {
        prompt: z.string().describe("매일 실행할 작업 지시"),
        time: z.string().describe("KST 기준 HH:MM, 예: 09:30"),
        enabled: z.boolean().optional().describe("생성 직후 활성화 여부 (기본 true)"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const prompt = args.prompt.trim();
        if (!prompt) {
          return text("prompt를 입력해 주세요.", true);
        }
        const minuteOfDay = parseTimeToMinute(args.time);
        if (minuteOfDay === null) {
          return text("time은 HH:MM 형식이어야 합니다.", true);
        }
        const routine = store.createRoutineJob(ctx.avatarUserId, {
          prompt,
          minuteOfDay,
          enabled: args.enabled,
        });
        store.audit({
          ...actor(ctx),
          action: "system_tool_create_routine",
          status: "success",
          detail: `routine ${routine.id} at ${routine.time}`,
        });
        return text(`루틴을 만들었습니다:\n${renderRoutine(routine)}`);
      },
    ),
    tool(
      "update_routine",
      "기존 루틴의 prompt, time(HH:MM KST), enabled 값을 수정한다. (소유자 전용)",
      {
        id: z.string().describe("수정할 루틴 id"),
        prompt: z.string().optional().describe("새 작업 지시"),
        time: z.string().optional().describe("KST 기준 HH:MM"),
        enabled: z.boolean().optional().describe("활성화 여부"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const patch: { prompt?: string; minuteOfDay?: number; enabled?: boolean } = {};
        if (args.prompt !== undefined) {
          const prompt = args.prompt.trim();
          if (!prompt) {
            return text("prompt를 입력해 주세요.", true);
          }
          patch.prompt = prompt;
        }
        if (args.time !== undefined) {
          const minuteOfDay = parseTimeToMinute(args.time);
          if (minuteOfDay === null) {
            return text("time은 HH:MM 형식이어야 합니다.", true);
          }
          patch.minuteOfDay = minuteOfDay;
        }
        if (args.enabled !== undefined) {
          patch.enabled = args.enabled;
        }
        if (Object.keys(patch).length === 0) {
          return text("수정할 값(prompt, time, enabled) 중 하나 이상이 필요합니다.", true);
        }
        const routine = store.updateRoutineJob(ctx.avatarUserId, args.id, patch);
        if (!routine) {
          return text("루틴을 찾을 수 없습니다.", true);
        }
        store.audit({
          ...actor(ctx),
          action: "system_tool_update_routine",
          status: "success",
          detail: `routine ${routine.id}`,
        });
        return text(`루틴을 수정했습니다:\n${renderRoutine(routine)}`);
      },
    ),
    tool(
      "delete_routine",
      "기존 루틴을 삭제한다. (소유자 전용)",
      { id: z.string().describe("삭제할 루틴 id") },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        if (!store.deleteRoutineJob(ctx.avatarUserId, args.id)) {
          return text("루틴을 찾을 수 없습니다.", true);
        }
        store.audit({
          ...actor(ctx),
          action: "system_tool_delete_routine",
          status: "success",
          detail: `routine ${args.id}`,
        });
        return text(`루틴을 삭제했습니다: ${args.id}`);
      },
    ),
    tool(
      "list_plugins",
      "소유자 아바타에 등록된 플러그인 목록을 조회한다. (소유자 전용)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const plugins = store.listPlugins(ctx.avatarUserId);
        if (plugins.length === 0) {
          return text("등록된 플러그인이 없습니다.");
        }
        return text(`등록된 플러그인 ${plugins.length}건:\n${plugins.map(renderPlugin).join("\n")}`);
      },
    ),
    tool(
      "add_plugin",
      "아바타에 GitHub/gitrepo 플러그인을 추가한다. repo는 owner/repo, https URL, git@ URL, .git URL을 허용한다. 추가한 플러그인은 다음 대화부터 로드된다. (소유자 전용)",
      {
        repo: z.string().describe("owner/repo 또는 git/https URL"),
        ref: z.string().optional().describe("브랜치/태그/커밋 ref (선택)"),
        label: z.string().optional().describe("표시용 이름 (선택)"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const repo = args.repo.trim();
        if (!repo || !looksLikeRepo(repo)) {
          return text("repo는 owner/repo 또는 git/https URL 형식이어야 합니다.", true);
        }
        const plugin = store.addPlugin(ctx.avatarUserId, {
          repo,
          ref: args.ref?.trim() || undefined,
          label: args.label?.trim() || undefined,
        });
        store.audit({
          ...actor(ctx),
          action: "system_tool_add_plugin",
          status: "success",
          detail: plugin.repo,
        });
        return text(
          `플러그인을 추가했습니다:\n${renderPlugin(plugin)}\n\n현재 대화에는 즉시 로드되지 않을 수 있습니다. 다음 대화부터 활성 플러그인으로 로드됩니다.`,
        );
      },
    ),
    tool(
      "set_plugin_enabled",
      "등록된 플러그인을 활성화하거나 비활성화한다. 변경은 다음 대화부터 로드 상태에 반영된다. (소유자 전용)",
      {
        id: z.string().describe("플러그인 id"),
        enabled: z.boolean().describe("활성화 여부"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const plugin = store.setPluginEnabled(ctx.avatarUserId, args.id, args.enabled);
        if (!plugin) {
          return text("플러그인을 찾을 수 없습니다.", true);
        }
        store.audit({
          ...actor(ctx),
          action: "system_tool_set_plugin_enabled",
          status: "success",
          detail: `${plugin.repo} enabled=${plugin.enabled}`,
        });
        return text(`플러그인 상태를 변경했습니다:\n${renderPlugin(plugin)}`);
      },
    ),
  ];
}

/** Build the in-process MCP server exposing avatar-system management tools. */
export function buildSystemServer(store: Store, ctx: SystemToolsContext) {
  return createSdkMcpServer({
    name: SYSTEM_SERVER_NAME,
    version: "0.1.0",
    tools: buildSystemTools(store, ctx),
  });
}
