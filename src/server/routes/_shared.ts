import fs from "node:fs";
import path from "node:path";
import { type Response } from "express";
import logger from "../logger.js";
import {
  groupKnowledgeRepoSkillSources,
  knowledgeRepoSkillSources,
  loadDefaultPluginRoots,
  resolvePluginRoots,
  syncPluginRepo,
} from "../plugins.js";
import { knowledgeRepoContextFor } from "../knowledgeRepo.js";
import { groupKnowledgeRepoContextsForUser } from "../groupKnowledgeRepo.js";
import { Store } from "../store.js";
import type { AppConfig, AvatarVisibility, PluginRoot } from "../types.js";
import { runAgentStream } from "../agent/index.js";
import { workspaceDirFor } from "../workspace.js";
import type { ScheduleError } from "../routineSchedule.js";
import type { AuthenticatedRequest } from "../auth.js";

export interface AppServices {
  config: AppConfig;
  store: Store;
}

/** A small mutable holder for the model the SDK last reported (chat → admin). */
export interface ObservedModelHolder {
  get(): string | null;
  set(model: string): void;
}

/** Dependencies every per-domain router factory receives from createApp. */
export interface RouterDeps {
  services: AppServices;
  config: AppConfig;
  store: Store;
  observedModel: ObservedModelHolder;
  /**
   * Audit the authenticated actor of `req` — collapses the repeated
   * `store.audit({ actorUserId, actorName, ... })` shape into one call site.
   */
  auditAs(
    req: AuthenticatedRequest,
    action: string,
    detail: string,
    status?: "success" | "error",
  ): void;
}

export const AVATAR_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
export const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MIN_PASSWORD_LENGTH = 8;

export function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function isAvatarVisibility(value: unknown): value is AvatarVisibility {
  return value === "public" || value === "group" || value === "private";
}

export function apiError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/** User-facing (Korean) messages for routine-schedule validation errors. */
export const KOREAN_SCHEDULE_ERROR: Record<ScheduleError, string> = {
  INVALID_KIND: "주기 종류가 올바르지 않습니다.",
  TIME_REQUIRED: "실행 시각(time)을 입력해 주세요.",
  INVALID_TIME: "time은 HH:MM 형식이어야 합니다.",
  DAYS_REQUIRED: "매주 반복은 요일을 1개 이상 선택해야 합니다.",
  INVALID_DAYS: "요일 값이 올바르지 않습니다 (0=일 ~ 6=토).",
  INTERVAL_REQUIRED: "반복 간격(분)을 입력해 주세요.",
  INVALID_INTERVAL: "반복 간격은 15분 이상 10080분(7일) 이하의 정수여야 합니다.",
};

export function avatarDir(config: AppConfig): string {
  return path.join(config.dataDir, "avatars");
}

export function looksLikeRepo(value: string): boolean {
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return true;
  }
  return /^https?:\/\//.test(value) || /^git@/.test(value) || value.endsWith(".git");
}

/** An avatar reference as needed by the skill-sourcing + headless-prompt helpers. */
interface SkillAvatar {
  id: string;
  displayName: string;
  alias: string;
  persona: string;
}

/**
 * Resolve the plugin roots + skills an avatar can use, attributing each source.
 * Shared by `/api/me/intro/generate`, `/api/me/hashtags/generate`, and
 * `/api/avatars/:id/skills` — they all walked the same default + per-plugin +
 * personal/group knowledge-repo loop. `includeGroupRepos` adds the owner's group
 * knowledge repos (the intro/hashtag generators count them; the skills panel does
 * not). Returns the attributed sources, the flattened skills, and pre-built
 * read-only `PluginRoot[]` for `runAgentStream`.
 */
export async function resolveAvatarSkillSources(
  store: Store,
  avatar: SkillAvatar,
  config: AppConfig,
  includeGroupRepos: boolean,
) {
  const sourced: { path: string; source: string }[] = [];
  // Repo-bundled defaults, loaded for every avatar.
  for (const root of await loadDefaultPluginRoots(config)) {
    sourced.push({ path: root.path, source: "default" });
  }
  // The avatar's own plugins, resolved per-repo so each skill is attributed.
  // Use the owner's internal/external git tokens like the chat path.
  const gitTokens = store.getGitTokens(avatar.id);
  const enabledPlugins = store.listEnabledPlugins(avatar.id);
  for (const plugin of enabledPlugins) {
    try {
      const dir = await syncPluginRepo(avatar.id, plugin, config, false, gitTokens);
      const label = plugin.label ?? plugin.repo;
      for (const root of await resolvePluginRoots(dir, plugin.repo, undefined, plugin.selected)) {
        sourced.push({ path: root, source: label });
      }
    } catch {
      /* a plugin that won't resolve just contributes no skills */
    }
  }
  // The avatar's own knowledge repo, so its accumulated skills surface too.
  sourced.push(...(await knowledgeRepoSkillSources(knowledgeRepoContextFor(store, avatar.id, config))));
  // Shared group knowledge repos the owner belongs to (intro/hashtags only).
  if (includeGroupRepos) {
    sourced.push(
      ...(await groupKnowledgeRepoSkillSources(groupKnowledgeRepoContextsForUser(store, avatar.id, config))),
    );
  }
  const pluginRoots: PluginRoot[] = sourced.map((s) => ({ type: "local", path: s.path }));
  return { sourced, enabledPlugins, pluginRoots };
}

/** A failed (`ok:false`) headless run vs. a successful one carrying the raw reply. */
export type HeadlessAvatarResult =
  | { ok: true; raw: string }
  | { ok: false };

/**
 * Run a headless, read-only, owner-scoped agent turn for the avatar's OWN
 * profile generators (intro/hashtags). Sets up the per-feature workspace, a
 * 2-minute abort deadline, and returns the raw reply text (`response.text ||
 * response.summary || ""`) on success, or `{ ok: false }` on a thrown run (the
 * caller maps that to the feature's "오류가 발생했습니다" 502; an empty-but-ok
 * reply is the caller's "생성하지 못했습니다" 502). Mirrors the routine path: no
 * human is mid-conversation.
 */
export async function runHeadlessAvatarPrompt(
  store: Store,
  config: AppConfig,
  avatar: SkillAvatar,
  feature: string,
  message: string,
  pluginRoots: PluginRoot[],
  failLog: string,
  userId: string,
): Promise<HeadlessAvatarResult> {
  const workspaceDir = workspaceDirFor(config, avatar.id, feature);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const abortController = new AbortController();
  const deadline = setTimeout(() => abortController.abort(), 2 * 60 * 1000);
  try {
    const response = await runAgentStream(
      {
        message,
        avatar: { id: avatar.id, displayName: avatar.displayName, alias: avatar.alias, persona: avatar.persona },
        cwd: workspaceDir,
        viewerUserId: avatar.id,
        viewerName: avatar.displayName,
        viewerIsOwner: true,
        headless: true,
      },
      pluginRoots,
      config,
      store,
      {},
      abortController,
    );
    return { ok: true, raw: response.text || response.summary || "" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn({ userId, detail }, failLog);
    return { ok: false };
  } finally {
    clearTimeout(deadline);
  }
}
