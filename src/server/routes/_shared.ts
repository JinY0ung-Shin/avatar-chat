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
import { scrubGitError } from "../marketplace.js";
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

/**
 * The absolute origin (`scheme://host`) the user's browser used to reach us,
 * honouring the reverse proxy via `x-forwarded-host`/`x-forwarded-proto` the
 * same way the browser-extension bundle stamping does (routes/browserExtension.ts)
 * — behind the corporate proxy `req.protocol` reports the internal http hop.
 * Null when no host header is present.
 */
export function requestOrigin(req: AuthenticatedRequest): string | null {
  const host = req.get("x-forwarded-host") || req.get("host");
  if (!host) return null;
  const proto = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${host}`;
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

const AVATAR_MIME_EXT: Record<string, string> = {
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
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MIN_PASSWORD_LENGTH = 8;

export function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

const SAFE_PATH_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafePathId(value: string): boolean {
  return SAFE_PATH_ID.test(value);
}

export function isAvatarVisibility(value: unknown): value is AvatarVisibility {
  return value === "group" || value === "private";
}

export function apiError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/**
 * The "what this avatar can actually do" block shared by `/api/me/intro/generate`
 * and `/api/me/hashtags/generate` — both ground the model in the avatar's skills,
 * connected plugins, and (optionally) reference persona. Agent-facing English.
 * Returns the exact block both endpoints interpolate as
 * `Available skills:\n…\n\nConnected plugins:\n…<persona>`.
 */
export function describeAvatarEquipment(
  skills: { name: string; description?: string }[],
  enabledPlugins: { label?: string | null; repo: string }[],
  persona?: string,
): string {
  const skillLines = skills.length
    ? skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`).join("\n")
    : "(no skills registered)";
  const pluginLines = enabledPlugins.length
    ? enabledPlugins.map((p) => `- ${p.label || p.repo}`).join("\n")
    : "(no plugins connected)";
  const personaLine = persona?.trim()
    ? `\n\nReference persona/instructions:\n${persona.trim()}`
    : "";
  return `Available skills:\n${skillLines}\n\nConnected plugins:\n${pluginLines}${personaLine}`;
}

/**
 * Map a knowledge-repo `readFile` rejection to its user-facing (Korean) HTTP
 * response — shared by the personal + group note endpoints, whose catch blocks
 * were byte-identical. Do NOT reuse `mcpTools.decodeRepoFsError` (English agent
 * channel).
 */
export function respondNoteFsError(res: Response, error: unknown): void {
  const err = error as NodeJS.ErrnoException;
  if (err.code === "ENOENT" || err.message === "INVALID_PATH" || err.message === "NOT_A_FILE") {
    apiError(res, 404, "노트를 찾을 수 없습니다.");
    return;
  }
  if (err.message === "FILE_TOO_LARGE") {
    apiError(res, 413, "노트가 너무 커서 표시할 수 없습니다.");
    return;
  }
  apiError(res, 502, `노트를 불러오지 못했습니다: ${scrubGitError(error)}`);
}

/** User-facing (Korean) messages for routine-schedule validation errors. */
export const KOREAN_SCHEDULE_ERROR: Record<ScheduleError, string> = {
  INVALID_KIND: "주기 종류가 올바르지 않습니다.",
  TIME_REQUIRED: "실행 시각(time)을 입력해 주세요.",
  INVALID_TIME: "time은 HH:MM 형식이어야 합니다.",
  DAYS_REQUIRED: "매주 반복은 요일을 1개 이상 선택해야 합니다.",
  INVALID_DAYS: "요일 값이 올바르지 않습니다 (0=일 ~ 6=토).",
  INTERVAL_REQUIRED: "반복 간격(분)을 입력해 주세요.",
  INVALID_INTERVAL: "반복 간격은 5분 이상 10080분(7일) 이하의 정수여야 합니다.",
  DATE_REQUIRED: "한 번만 실행할 날짜(date)를 입력해 주세요.",
  INVALID_DATE: "date는 YYYY-MM-DD 형식의 올바른 날짜여야 합니다.",
  DATE_IN_PAST: "한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다.",
};

export function avatarDir(config: AppConfig): string {
  return path.join(config.dataDir, "avatars");
}

/**
 * Decode + validate a data-URL avatar upload (png/jpeg/webp, ≤ MAX_AVATAR_BYTES).
 * Shared by the profile photo upload and the admin external-avatar photo upload
 * so the accepted formats/limits can't drift apart.
 */
export function decodeAvatarImage(
  image: unknown,
): { ext: string; buffer: Buffer } | { error: string } {
  const match =
    typeof image === "string"
      ? /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image)
      : null;
  if (!match) {
    return { error: "지원하는 이미지 형식은 png/jpeg/webp 입니다." };
  }
  const ext = AVATAR_MIME_EXT[match[1]];
  let buffer: Buffer;
  try {
    buffer = Buffer.from(match[2], "base64");
  } catch {
    return { error: "이미지를 디코드할 수 없습니다." };
  }
  if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) {
    return { error: "이미지 크기는 2MB 이하여야 합니다." };
  }
  return { ext, buffer };
}

/**
 * Write an avatar image under avatarDir as `<stem>.<ext>`, removing any stale
 * sibling extension so prior files don't linger. The stem is either a user id
 * or an external avatar id — both come from server-validated registries, never
 * raw client input.
 */
export function saveAvatarImageFile(
  config: AppConfig,
  stem: string,
  ext: string,
  buffer: Buffer,
): void {
  const dir = avatarDir(config);
  fs.mkdirSync(dir, { recursive: true });
  for (const candidate of ["png", "jpg", "webp"]) {
    const prior = path.join(dir, `${stem}.${candidate}`);
    if (candidate !== ext && fs.existsSync(prior)) {
      fs.rmSync(prior, { force: true });
    }
  }
  fs.writeFileSync(path.join(dir, `${stem}.${ext}`), buffer);
}

/** Remove an avatar image file (no-op when ext is null/unknown). */
export function deleteAvatarImageFile(
  config: AppConfig,
  stem: string,
  ext: string | null,
): void {
  if (!ext) return;
  fs.rmSync(path.join(avatarDir(config), `${stem}.${ext}`), { force: true });
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
type HeadlessAvatarResult =
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
