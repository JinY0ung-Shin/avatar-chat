import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Response } from "express";
import {
  clearSessionCookie,
  requireAdmin,
  requireAuth,
  sessionTokenFromRequest,
  setSessionCookie,
  type AuthenticatedRequest,
} from "./auth.js";
import { loadConfig } from "./config.js";
import logger from "./logger.js";
import {
  forgetClone,
  groupKnowledgeRepoSkillSources,
  inspectRepoContents,
  knowledgeRepoSkillSources,
  listSkillsInRoots,
  loadAvatarPluginRoots,
  loadDefaultPluginRoots,
  loadGroupKnowledgeRepoRoots,
  loadKnowledgeRepoRoots,
  pluginClonePath,
  resolvePluginRoots,
  syncPluginRepo,
} from "./plugins.js";
import { scrubGitError } from "./marketplace.js";
import { isInternalGitSource } from "./gitCredentials.js";
import { ensureClone, knowledgeClonePath, knowledgeRepoContextFor } from "./knowledgeRepo.js";
import { knownHostsPath } from "./sshTrust.js";
import {
  ensureGroupClone,
  groupKnowledgeRepoContextFor,
  groupKnowledgeRepoContextsForUser,
} from "./groupKnowledgeRepo.js";
import { Store, CLAUDE_OAUTH_TOKEN_KEY, normalizeHashtags } from "./store.js";
import type { AgentConversationMessage, AgentResponse, AppConfig, PluginRoot, StoredMessage } from "./types.js";
import { runAgentStream } from "./agent/index.js";
import { generateSshKeyPair } from "./sshIdentity.js";
import { createRateLimiter } from "./rateLimit.js";
import {
  attachRunClient,
  awaitResponse,
  cancelRun,
  closeRun,
  emitRunEvent,
  getActiveRun,
  getActiveRunForConversation,
  isRunCancelled,
  openRun,
  submitResponse,
  CANCELLED,
} from "./agent/runRegistry.js";
import { executeRoutineJob, isRoutineRunning } from "./scheduler.js";
import { workspaceDirFor } from "./workspace.js";
import { HEX_SSH_TOOL_INFOS, parseHexSshToolPolicy } from "./hexSshPolicy.js";

export interface AppServices {
  config: AppConfig;
  store: Store;
}

const AVATAR_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 8;

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function apiError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function avatarDir(config: AppConfig): string {
  return path.join(config.dataDir, "avatars");
}

/** Parse a daily-run time ("HH:MM" or 0..1439 integer) into minutes-of-day. */
function parseTimeToMinute(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439) {
    return value;
  }
  if (typeof value === "string") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (match) {
      const h = Number(match[1]);
      const m = Number(match[2]);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        return h * 60 + m;
      }
    }
  }
  return null;
}

function looksLikeRepo(value: string): boolean {
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return true;
  }
  return /^https?:\/\//.test(value) || /^git@/.test(value) || value.endsWith(".git");
}

interface ChatSlashExpansion {
  message: string;
  error?: string;
  ownerOnly?: boolean;
}

const LEARN_SLASH_PROMPT = [
  "이번 대화 세션을 검토해서 앞으로 재사용할 가치가 있는 지식만 선별해 내 지식 저장소를 업데이트해줘.",
  "",
  "중요한 사실, 결정사항, 반복 가능한 절차, 프로젝트 규칙, 사용자가 선호한다고 밝힌 방식이 있으면 적절한 파일이나 스킬에 반영하고 커밋해줘.",
  "이미 저장돼 있거나 장기적으로 유용하지 않은 잡담은 저장하지 말고, 저장한 내용과 저장하지 않은 이유를 간단히 알려줘.",
].join("\n");

export function expandChatSlashCommand(message: string): ChatSlashExpansion {
  const trimmed = message.trim();
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return { message };
  }

  const command = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  switch (command) {
    case "learn":
      return { message: LEARN_SLASH_PROMPT, ownerOnly: true };
    case "summarize":
      return { message: "지금까지의 대화를 핵심 결정사항, 해야 할 일, 열린 질문으로 나눠 요약해줘." };
    case "remember":
      return args
        ? {
            message: `다음 내용을 내 지식 저장소에 기록해서 앞으로 같은 질문에 답할 수 있게 해줘.\n\n${args}`,
            ownerOnly: true,
          }
        : { message, error: "/remember 뒤에 저장할 내용을 입력해 주세요.", ownerOnly: true };
    case "routine":
      return args
        ? { message: `매일 HH:MM KST에 다음 일을 실행하는 루틴을 만들어줘.\n\n${args}`, ownerOnly: true }
        : { message, error: "/routine 뒤에 작업 내용을 입력해 주세요.", ownerOnly: true };
    case "find":
      return args
        ? { message: `이 요청에 더 적합한 팀원 아바타가 있는지 찾아보고 추천해줘.\n\n${args}` }
        : { message, error: "/find 뒤에 요청 내용을 입력해 주세요." };
    case "new":
      return { message, error: "/new는 입력창의 슬래시 메뉴에서 새 대화로 실행해 주세요." };
    default:
      return { message };
  }
}

export function createServices(configOverrides: Partial<AppConfig> = {}): AppServices {
  const config = loadConfig(configOverrides);
  const store = new Store(config);
  return { config, store };
}

function prepareSse(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function isEmptyStoppedAssistant(message: StoredMessage): boolean {
  return (
    message.role === "assistant" &&
    message.content.trim() === "(중지됨)" &&
    message.response?.summary === "중지됨" &&
    !message.response.text?.trim()
  );
}

export function conversationHistoryForPrompt(messages: StoredMessage[]): AgentConversationMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") {
      return [];
    }
    if (!message.content.trim() || isEmptyStoppedAssistant(message)) {
      return [];
    }
    return [{ role: message.role, content: message.content }];
  });
}

export function createApp(services = createServices()) {
  const { config, store } = services;
  // The model the SDK last reported via its `init` event. Null until the first
  // Claude run reports one; the admin "system info" view surfaces it alongside
  // the configured model so an operator can confirm what actually ran.
  let observedModel: string | null = null;
  const app = express();
  app.use(express.json({ limit: "3mb" }));

  // ---- Security headers ---------------------------------------------------
  // CSP locks scripts/connections/images to same-origin. The avatar renders
  // untrusted markdown (colleague turns, fetched pages, repo files): img-src
  // 'self' data: neutralizes the classic remote-image exfiltration beacon, and
  // script-src 'self' means a DOMPurify miss can't execute injected script.
  // Every asset is same-origin (vendored marked/dompurify, local fonts), so this
  // is low-friction. NOTE: it also blocks remote <img> in rendered markdown by
  // design — relax img-src if remote images are wanted.
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });

  // Throttle credential guessing / signup floods (in-memory, single-process;
  // bypassed under NODE_ENV=test). Login is keyed per (ip, username) so one
  // account can't be hammered; signup is keyed per ip.
  const loginLimiter = createRateLimiter({
    windowMs: 5 * 60 * 1000,
    max: 20,
    keyFn: (req) =>
      `${req.ip ?? "?"}:${safeString((req.body as { username?: unknown } | undefined)?.username).toLowerCase()}`,
    message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  });
  const signupLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyFn: (req) => req.ip ?? "?",
  });

  app.use(
    "/fonts/noto-sans-kr",
    express.static(path.join(process.cwd(), "node_modules", "@fontsource-variable", "noto-sans-kr")),
  );

  app.get("/vendor/marked.esm.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(process.cwd(), "node_modules", "marked", "lib", "marked.esm.js"));
  });
  app.get("/vendor/purify.es.mjs", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(process.cwd(), "node_modules", "dompurify", "dist", "purify.es.mjs"));
  });

  app.use(express.static(path.join(process.cwd(), "public")));

  // ---- Request logging ----------------------------------------------------
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) {
      next();
      return;
    }
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: duration,
          userId: (req as AuthenticatedRequest).user?.id ?? null,
        },
        "request",
      );
    });
    next();
  });

  // ---- Auth ------------------------------------------------------------

  app.post("/api/auth/signup", signupLimiter, (req, res) => {
    const username = safeString(req.body?.username);
    const displayName = safeString(req.body?.displayName) || username;
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!username || !/^[\w.-]{3,32}$/.test(username)) {
      apiError(res, 400, "사용자명은 3~32자의 영문/숫자/._- 만 허용됩니다.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      apiError(res, 400, "비밀번호는 8자 이상이어야 합니다.");
      return;
    }
    // The very first account (admin bootstrap) is always allowed; after that the
    // admin-configured signup mode gates self-service registration.
    const isFirstUser = !store.hasAnyUser();
    const signupMode = store.getSignupMode();
    if (!isFirstUser && signupMode === "closed") {
      apiError(res, 403, "현재 회원가입이 비활성화되어 있습니다. 관리자에게 문의하세요.");
      return;
    }
    let user;
    try {
      user = store.createUser({ username, displayName, password });
    } catch (error) {
      if (error instanceof Error && error.message === "DUPLICATE_USERNAME") {
        apiError(res, 409, "이미 사용 중인 사용자명입니다.");
        return;
      }
      throw error;
    }
    // Approval mode: the account is created but parked (suspended) with no session
    // until an admin activates it. The client shows a "pending approval" notice.
    if (!isFirstUser && signupMode === "approval") {
      store.setSuspended(user.id, true);
      store.audit({
        actorUserId: user.id,
        actorName: user.username,
        action: "signup_pending",
        status: "success",
        detail: "awaiting admin approval",
      });
      logger.info({ userId: user.id, username: user.username }, "signup pending approval");
      res.status(202).json({ pending: true });
      return;
    }
    const token = store.createSession(user.id);
    setSessionCookie(res, token);
    store.audit({
      actorUserId: user.id,
      actorName: user.username,
      action: "signup",
      status: "success",
      detail: `signup as ${user.roles.join("/")}`,
    });
    logger.info({ userId: user.id, username: user.username }, "signup");
    res.status(201).json({ user });
  });

  app.post("/api/auth/login", loginLimiter, (req, res) => {
    const username = safeString(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = store.verifyLogin(username, password);
    if (user === "suspended") {
      apiError(res, 403, "비활성화된 계정입니다. 관리자 승인이나 문의가 필요합니다.");
      return;
    }
    if (!user) {
      apiError(res, 401, "사용자명 또는 비밀번호가 올바르지 않습니다.");
      return;
    }
    const token = store.createSession(user.id);
    setSessionCookie(res, token);
    store.audit({
      actorUserId: user.id,
      actorName: user.username,
      action: "login",
      status: "success",
      detail: "login",
    });
    logger.info({ userId: user.id, username: user.username }, "login");
    res.json({ user });
  });

  app.post("/api/auth/logout", (req, res) => {
    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    store.revokeSession(sessionTokenFromRequest(req));
    clearSessionCookie(res);
    if (user) {
      logger.info({ userId: user.id, username: user.username }, "logout");
    }
    res.json({ ok: true });
  });

  // First-run probe: when no account exists yet, the client shows the
  // admin-account setup screen instead of the normal login.
  app.get("/api/bootstrap", (_req, res) => {
    res.json({
      needsSetup: !store.hasAnyUser(),
      githubHost: config.githubHost,
      // Lets the auth screen hide/adjust the signup affordance and show the right
      // copy (open vs. approval vs. closed) before anyone tries to register.
      signupMode: store.getSignupMode(),
    });
  });

  app.get("/api/me", (req, res) => {
    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    res.json({ user });
  });

  // ---- Profile ---------------------------------------------------------

  app.patch("/api/me", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const patch: {
      displayName?: string;
      alias?: string;
      bio?: string;
      persona?: string;
      intro?: string;
      hashtags?: string[];
      published?: boolean;
    } = {};
    if (typeof req.body?.displayName === "string") patch.displayName = req.body.displayName;
    if (typeof req.body?.alias === "string") patch.alias = req.body.alias;
    if (typeof req.body?.bio === "string") patch.bio = req.body.bio;
    if (typeof req.body?.persona === "string") patch.persona = req.body.persona;
    if (typeof req.body?.intro === "string") patch.intro = req.body.intro;
    // Accept an array of tag strings; updateProfile normalizes/caps it.
    if (Array.isArray(req.body?.hashtags)) {
      patch.hashtags = req.body.hashtags.filter((t: unknown): t is string => typeof t === "string");
    }
    if (typeof req.body?.published === "boolean") patch.published = req.body.published;
    const user = store.updateProfile(req.user!.id, patch);
    res.json({ user });
  });

  // ---- Trusted users ---------------------------------------------------
  // The owner designates users who may chat with their avatar at the owner's
  // tool-permission level (write/Bash run, not just read-only). Trust does NOT
  // grant the owner-only knowledge inbox or greeting (see AgentRequest.elevated).

  app.get("/api/me/trusted", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ trusted: store.listTrustedUsers(req.user!.id) });
  });

  // Typeahead for the trusted-user picker: match by username OR display name.
  // Excludes self; flags users already trusted. (Exact path before /:id below;
  // GET /:id isn't a route, but keep this above the DELETE for readability.)
  app.get("/api/me/trusted/search", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const q = safeString(req.query?.q);
    res.json({ users: q ? store.searchUsers(q, req.user!.id) : [] });
  });

  app.post("/api/me/trusted", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const username = safeString(req.body?.username);
    if (!username) {
      apiError(res, 400, "사용자 이름을 입력해 주세요.");
      return;
    }
    const added = store.addTrustedUser(req.user!.id, username);
    if (!added) {
      apiError(res, 404, "해당 사용자를 찾을 수 없거나 자기 자신은 추가할 수 없습니다.");
      return;
    }
    res.json({ trusted: store.listTrustedUsers(req.user!.id), added });
  });

  app.delete("/api/me/trusted/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    store.removeTrustedUser(req.user!.id, req.params.id);
    res.json({ trusted: store.listTrustedUsers(req.user!.id) });
  });

  // Generate a first-person self-introduction for the owner's avatar. The
  // avatar inspects its own persona + skills and writes a short blurb the owner
  // then reviews/edits before saving (this endpoint does NOT persist it). Runs
  // headless and read-only, like a routine — no human is mid-conversation.
  app.post("/api/me/intro/generate", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const avatar = store.resolveChatAvatar(req.user!.id, req.user!.id);
    if (!avatar) {
      apiError(res, 404, "아바타를 찾을 수 없습니다.");
      return;
    }

    // The local runtime loads no plugins and can't introspect skills; return a
    // deterministic placeholder so the feature still works offline/in tests.
    if (config.agentRuntime === "local") {
      const name = avatar.alias || avatar.displayName;
      res.json({ intro: `안녕하세요, ${name}입니다. 무엇이든 편하게 물어보세요.` });
      return;
    }

    // Resolve plugin roots and their skills exactly like the skills endpoint,
    // so the intro reflects what the avatar can actually do.
    const sourced: { path: string; source: string }[] = [];
    for (const root of await loadDefaultPluginRoots(config)) {
      sourced.push({ path: root.path, source: "default" });
    }
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
    // The avatar's own knowledge repo, so the intro reflects skills it accumulated.
    sourced.push(...(await knowledgeRepoSkillSources(knowledgeRepoContextFor(store, avatar.id, config))));
    // Shared group knowledge repos the owner belongs to count toward the intro too.
    sourced.push(
      ...(await groupKnowledgeRepoSkillSources(groupKnowledgeRepoContextsForUser(store, avatar.id, config))),
    );
    const skills = await listSkillsInRoots(sourced);
    const pluginRoots: PluginRoot[] = sourced.map((s) => ({ type: "local", path: s.path }));

    // Describe the avatar's equipment so it can ground the intro in reality
    // rather than inventing capabilities.
    const skillLines = skills.length
      ? skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`).join("\n")
      : "(등록된 스킬 없음)";
    const pluginLines = enabledPlugins.length
      ? enabledPlugins.map((p) => `- ${p.label || p.repo}`).join("\n")
      : "(연결된 플러그인 없음)";
    const personaLine = avatar.persona?.trim()
      ? `\n\n참고용 페르소나/지침:\n${avatar.persona.trim()}`
      : "";
    const message =
      "당신은 자기 자신을 소개하는 짧은 글을 작성합니다. 대화 상대(동료)가 당신과 대화를 시작하기 전에 읽을 소개글입니다.\n\n" +
      "다음 정보를 바탕으로, 1인칭 시점으로 '당신이 무엇을 도와줄 수 있는지'를 중심으로 자기소개를 작성하세요. " +
      "갖춘 스킬·도구를 근거로 구체적인 역량을 드러내되 과장하지 마세요.\n\n" +
      "마크다운 형식으로 출력하세요. 한두 문장의 짧은 인사 문단으로 시작한 뒤, " +
      "주요 역량은 불릿 목록(`- `)으로 정리하세요. 각 불릿은 '무엇을 도울 수 있는지' 한 줄로 쓰고, " +
      "필요하면 굵게(`**`)로 핵심 키워드를 강조하세요. 마크다운 제목(`#`)·코드블록·따옴표 감싸기는 쓰지 말고, " +
      "소개 본문만 출력하세요.\n\n" +
      `사용 가능한 스킬:\n${skillLines}\n\n연결된 플러그인:\n${pluginLines}${personaLine}`;

    const workspaceDir = workspaceDirFor(config, avatar.id, "intro");
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
      const intro = (response.text || response.summary || "").trim();
      if (!intro) {
        apiError(res, 502, "소개글을 생성하지 못했습니다. 다시 시도해 주세요.");
        return;
      }
      res.json({ intro });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn({ userId: req.user!.id, detail }, "intro generation failed");
      apiError(res, 502, "소개글 생성 중 오류가 발생했습니다.");
    } finally {
      clearTimeout(deadline);
    }
  });

  // Generate capability hashtags (역량 해시태그) for the owner's avatar, mirroring
  // intro/generate: the avatar inspects its persona + skills and proposes a short
  // set of searchable tags the owner reviews/edits before saving (NOT persisted
  // here). Runs headless + read-only, like a routine.
  app.post("/api/me/hashtags/generate", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const avatar = store.resolveChatAvatar(req.user!.id, req.user!.id);
    if (!avatar) {
      apiError(res, 404, "아바타를 찾을 수 없습니다.");
      return;
    }

    // The local runtime can't introspect skills; return a deterministic
    // placeholder so the feature still works offline/in tests.
    if (config.agentRuntime === "local") {
      res.json({ hashtags: ["업무지원", "질문답변"] });
      return;
    }

    // Resolve plugin roots + skills exactly like intro/generate, so the tags
    // reflect what the avatar can actually do.
    const sourced: { path: string; source: string }[] = [];
    for (const root of await loadDefaultPluginRoots(config)) {
      sourced.push({ path: root.path, source: "default" });
    }
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
    sourced.push(...(await knowledgeRepoSkillSources(knowledgeRepoContextFor(store, avatar.id, config))));
    sourced.push(
      ...(await groupKnowledgeRepoSkillSources(groupKnowledgeRepoContextsForUser(store, avatar.id, config))),
    );
    const skills = await listSkillsInRoots(sourced);
    const pluginRoots: PluginRoot[] = sourced.map((s) => ({ type: "local", path: s.path }));

    const skillLines = skills.length
      ? skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`).join("\n")
      : "(등록된 스킬 없음)";
    const pluginLines = enabledPlugins.length
      ? enabledPlugins.map((p) => `- ${p.label || p.repo}`).join("\n")
      : "(연결된 플러그인 없음)";
    const personaLine = avatar.persona?.trim()
      ? `\n\n참고용 페르소나/지침:\n${avatar.persona.trim()}`
      : "";
    const message =
      "당신은 자기 자신을 검색·분류하기 위한 '역량 해시태그'를 만듭니다. 동료들이 탐색 화면에서 당신이 무엇을 할 수 있는지 키워드로 찾을 수 있게 돕는 태그입니다.\n\n" +
      "다음 정보를 바탕으로, 당신이 실제로 도와줄 수 있는 핵심 역량·도메인·도구를 나타내는 해시태그 5~12개를 만드세요. " +
      "갖춘 스킬·플러그인·페르소나를 근거로 하고, 없는 능력은 지어내지 마세요.\n\n" +
      "출력 형식: 해시태그만 공백으로 구분해 한 줄로 출력하세요. 각 태그는 `#`로 시작하고 공백 없이 쓰세요(여러 단어는 붙이거나 하이픈으로 연결). " +
      "한국어를 기본으로 하되 널리 쓰이는 기술 용어는 영어로 써도 됩니다. 설명 문장·목록·코드블록 없이 해시태그 줄만 출력하세요.\n" +
      "예시: #코드리뷰 #파이썬 #데이터분석 #기술문서작성\n\n" +
      `사용 가능한 스킬:\n${skillLines}\n\n연결된 플러그인:\n${pluginLines}${personaLine}`;

    const workspaceDir = workspaceDirFor(config, avatar.id, "hashtags");
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
      // Prefer explicit "#tag" tokens; fall back to splitting the whole reply.
      const raw = response.text || response.summary || "";
      const tagged = [...raw.matchAll(/#([^\s#,，、]+)/g)].map((m) => m[1]);
      const hashtags = normalizeHashtags(tagged.length ? tagged : raw);
      if (hashtags.length === 0) {
        apiError(res, 502, "해시태그를 생성하지 못했습니다. 다시 시도해 주세요.");
        return;
      }
      res.json({ hashtags });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn({ userId: req.user!.id, detail }, "hashtag generation failed");
      apiError(res, 502, "해시태그 생성 중 오류가 발생했습니다.");
    } finally {
      clearTimeout(deadline);
    }
  });

  app.put("/api/me/avatar-image", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const image = typeof req.body?.image === "string" ? req.body.image : "";
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image);
    if (!match) {
      apiError(res, 400, "지원하는 이미지 형식은 png/jpeg/webp 입니다.");
      return;
    }
    const mime = match[1];
    const ext = AVATAR_MIME_EXT[mime];
    let buffer: Buffer;
    try {
      buffer = Buffer.from(match[2], "base64");
    } catch {
      apiError(res, 400, "이미지를 디코드할 수 없습니다.");
      return;
    }
    if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) {
      apiError(res, 400, "이미지 크기는 2MB 이하여야 합니다.");
      return;
    }
    const dir = avatarDir(config);
    fs.mkdirSync(dir, { recursive: true });
    // Remove any prior extension so stale files don't linger.
    for (const candidate of ["png", "jpg", "webp"]) {
      const prior = path.join(dir, `${req.user!.id}.${candidate}`);
      if (candidate !== ext && fs.existsSync(prior)) {
        fs.rmSync(prior, { force: true });
      }
    }
    fs.writeFileSync(path.join(dir, `${req.user!.id}.${ext}`), buffer);
    store.setAvatarExt(req.user!.id, ext);
    res.json({ ok: true, hasImage: true });
  });

  app.delete("/api/me/avatar-image", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ext = store.getAvatarExt(req.user!.id);
    if (ext) {
      const file = path.join(avatarDir(config), `${req.user!.id}.${ext}`);
      fs.rmSync(file, { force: true });
    }
    store.setAvatarExt(req.user!.id, null);
    res.json({ ok: true, hasImage: false });
  });

  app.get("/api/users/:id/avatar-image", (req, res) => {
    const ext = store.getAvatarExt(req.params.id);
    if (!ext) {
      res.status(404).json({ error: "No avatar image" });
      return;
    }
    const file = path.join(avatarDir(config), `${req.params.id}.${ext}`);
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "No avatar image" });
      return;
    }
    res.type(EXT_MIME[ext] ?? "application/octet-stream");
    res.sendFile(file);
  });

  // ---- Plugins ---------------------------------------------------------

  app.get("/api/me/plugins", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ plugins: store.listPlugins(req.user!.id) });
  });

  app.post("/api/me/plugins", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const repo = safeString(req.body?.repo);
    if (!repo || !looksLikeRepo(repo)) {
      apiError(res, 400, "repo는 owner/repo 또는 git/https URL 형식이어야 합니다.");
      return;
    }
    const ref = safeString(req.body?.ref) || undefined;
    const label = safeString(req.body?.label) || undefined;
    const plugin = store.addPlugin(req.user!.id, { repo, ref, label });
    logger.info({ userId: req.user!.id, pluginId: plugin.id, repo }, "plugin added");
    res.json({ plugin });
  });

  app.patch("/api/me/plugins/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const id = req.params.id;
    const body = req.body ?? {};
    const hasEnabled = typeof body.enabled === "boolean";
    const hasSelected = "selected" in body;
    const hasRef = "ref" in body;
    if (!hasEnabled && !hasSelected && !hasRef) {
      apiError(res, 400, "enabled(boolean), selected(배열|null), 또는 ref(문자열|null) 중 하나가 필요합니다.");
      return;
    }
    // Validate `selected`: null (= load all) or an array of plugin-name strings.
    let selected: string[] | null | undefined;
    if (hasSelected) {
      const raw = body.selected;
      if (raw === null) {
        selected = null;
      } else if (Array.isArray(raw) && raw.every((s) => typeof s === "string")) {
        selected = raw as string[];
      } else {
        apiError(res, 400, "selected는 문자열 배열이거나 null이어야 합니다.");
        return;
      }
    }
    if (!store.getPlugin(userId, id)) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    let plugin = store.getPlugin(userId, id);
    if (hasEnabled) {
      plugin = store.setPluginEnabled(userId, id, body.enabled);
    }
    if (hasSelected) {
      plugin = store.setPluginSelected(userId, id, selected ?? null);
    }
    if (hasRef) {
      plugin = store.setPluginRef(userId, id, safeString(body.ref) || null);
      // Drop the clone cache so the next sync checks out the new ref.
      forgetClone(pluginClonePath(userId, plugin!.repo, config));
    }
    res.json({ plugin });
  });

  // List the plugins a repo contains (clones/caches it), for the selection UI.
  app.get("/api/me/plugins/:id/contents", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const plugin = store.getPlugin(req.user!.id, req.params.id);
    if (!plugin) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    try {
      const dir = await syncPluginRepo(req.user!.id, plugin, config, false, store.getGitTokens(req.user!.id));
      store.markPluginSynced(req.user!.id, req.params.id);
      const contents = await inspectRepoContents(dir);
      res.json({ contents });
    } catch (error) {
      const detail = scrubGitError(error);
      apiError(res, 502, `저장소를 가져오지 못했습니다: ${detail}`);
    }
  });

  // Force-refresh a plugin's clone (git fetch + checkout), bypassing the cache.
  app.post("/api/me/plugins/:id/refresh", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const plugin = store.getPlugin(req.user!.id, req.params.id);
    if (!plugin) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    try {
      await syncPluginRepo(req.user!.id, plugin, config, true, store.getGitTokens(req.user!.id));
      const updated = store.markPluginSynced(req.user!.id, req.params.id);
      res.json({ plugin: updated });
    } catch (error) {
      const detail = scrubGitError(error);
      apiError(res, 502, `새로고침 실패: ${detail}`);
    }
  });

  app.delete("/api/me/plugins/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const removed = store.deletePlugin(req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    logger.info({ userId: req.user!.id, pluginId: req.params.id }, "plugin removed");
    res.json({ ok: true });
  });

  // ---- Git credentials & personal knowledge repo ----------------------
  // The knowledge repo is browsed/edited/committed by the AVATAR via chat (the
  // owner-only `mcp__repo__*` tools), not here — these routes only store the
  // token, the commit identity, and the repo location.

  // Set (or clear) the user's internal Git token. Write-only: the token is
  // never returned — `user.gitTokenSet` reflects whether GIT_TOKEN is stored.
  app.put("/api/me/git-token", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) {
      apiError(res, 400, "token을 입력해 주세요.");
      return;
    }
    const user = store.setGitToken(req.user!.id, token);
    logger.info({ userId: req.user!.id }, "internal git token set");
    res.json({ user });
  });

  app.delete("/api/me/git-token", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const user = store.setGitToken(req.user!.id, null);
    logger.info({ userId: req.user!.id }, "internal git token cleared");
    res.json({ user });
  });

  // Per-user secrets: named values (e.g. SSH_PRIVATE_KEY) encrypted at rest and
  // injected ONLY into the avatar's MCP subprocess env — never returned to the
  // client or visible to the agent. `user.secretNames` lists which are set.
  // The name must be a valid env-var key so it can be passed through as-is.
  const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

  app.put("/api/me/secrets/:name", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = String(req.params.name || "");
    if (!SECRET_NAME_RE.test(name)) {
      apiError(res, 400, "secret 이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다.");
      return;
    }
    const value = typeof req.body?.value === "string" ? req.body.value : "";
    if (!value) {
      apiError(res, 400, "value를 입력해 주세요.");
      return;
    }
    store.setUserSecret(req.user!.id, name, value);
    logger.info({ userId: req.user!.id, name }, "user secret set");
    res.json({ user: store.getUserById(req.user!.id) });
  });

  app.delete("/api/me/secrets/:name", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = String(req.params.name || "");
    store.deleteUserSecret(req.user!.id, name);
    logger.info({ userId: req.user!.id, name }, "user secret cleared");
    res.json({ user: store.getUserById(req.user!.id) });
  });

  app.post("/api/me/ssh-key", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const user = store.getUserById(req.user!.id);
    const secretNames = store.listUserSecretNames(req.user!.id);
    if (secretNames.includes("SSH_PRIVATE_KEY") || user?.sshPublicKey) {
      apiError(
        res,
        409,
        user?.sshPublicKey
          ? "이미 SSH 키가 설정되어 있습니다."
          : "이미 SSH_PRIVATE_KEY 시크릿이 설정되어 있습니다.",
      );
      return;
    }
    try {
      const pair = await generateSshKeyPair(`avatar-chat-${req.user!.username}`);
      const updated = store.setSshKeyPair(req.user!.id, pair.privateKey, pair.publicKey);
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "ssh_identity_generate_key",
        status: "ok",
        detail: JSON.stringify({ fingerprint: pair.fingerprint, source: "settings" }),
      });
      logger.info({ userId: req.user!.id }, "ssh key generated");
      res.json({ user: updated, publicKey: pair.publicKey, fingerprint: pair.fingerprint });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      apiError(res, 500, `SSH 키를 생성하지 못했습니다: ${message}`);
    }
  });

  // Set the commit author identity used for knowledge-repo commits.
  app.put("/api/me/git-identity", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = safeString(req.body?.name) || null;
    const email = safeString(req.body?.email) || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      apiError(res, 400, "email 형식이 올바르지 않습니다.");
      return;
    }
    const user = store.setGitIdentity(req.user!.id, name, email);
    res.json({ user });
  });

  // Point the user at a personal knowledge repo (owner/repo or git URL). The
  // avatar manages the repo's contents itself via chat; this only stores where
  // it lives. An empty/null repo clears it.
  app.put("/api/me/knowledge-repo", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const repoRaw = req.body?.repo;
    if (repoRaw === null || repoRaw === "") {
      const user = store.setKnowledgeRepo(req.user!.id, null, null);
      res.json({ user });
      return;
    }
    const repo = safeString(repoRaw);
    if (!repo || !looksLikeRepo(repo)) {
      apiError(res, 400, "repo는 owner/repo 또는 git/https URL 형식이어야 합니다.");
      return;
    }
    if (!isInternalGitSource(repo, config.githubHost)) {
      apiError(res, 400, `지식 저장소는 사내 GitHub host(${config.githubHost})에 있어야 합니다.`);
      return;
    }
    const branch = safeString(req.body?.branch) || null;
    const user = store.setKnowledgeRepo(req.user!.id, repo, branch);
    res.json({ user });
  });

  // List the plugins the connected knowledge repo contains, for the selection
  // UI. Clones/fetches the repo (same working tree the agent's repo tools use).
  app.get("/api/me/knowledge-repo/contents", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    try {
      const repoRoot = await ensureClone(ctx);
      const contents = await inspectRepoContents(repoRoot);
      res.json({ contents });
    } catch (error) {
      apiError(res, 502, `저장소를 가져오지 못했습니다: ${scrubGitError(error)}`);
    }
  });

  // Force a re-sync of the connected knowledge repo from its remote. `ensureClone`
  // already does `git fetch --prune` + `checkout -B <branch> origin/<branch>` on
  // every call, so this is simply ensureClone + return the (possibly changed)
  // plugin list. No clone-cache to clear — knowledge repos aren't in `clonedPaths`.
  app.post("/api/me/knowledge-repo/refresh", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    try {
      const repoRoot = await ensureClone(ctx);
      const contents = await inspectRepoContents(repoRoot);
      res.json({ contents });
    } catch (error) {
      apiError(res, 502, `새로고침 실패: ${scrubGitError(error)}`);
    }
  });

  // Choose which knowledge-repo plugins the avatar loads. `selected: null`
  // (or all/empty) means "load all" — the repo is the avatar's by default.
  app.put("/api/me/knowledge-repo/selected", requireAuth(store), (req: AuthenticatedRequest, res) => {
    if (!store.getKnowledgeRepo(req.user!.id).repo) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    const raw = req.body?.selected;
    let selected: string[] | null;
    if (raw === null || raw === undefined) {
      selected = null;
    } else if (Array.isArray(raw) && raw.every((s) => typeof s === "string")) {
      selected = raw as string[];
    } else {
      apiError(res, 400, "selected는 문자열 배열이거나 null이어야 합니다.");
      return;
    }
    const user = store.setKnowledgeSelected(req.user!.id, selected);
    res.json({ user });
  });

  // ---- Groups (membership roster + group-admin self-service) -----------
  // Members of a group auto-trust each other (store.isTrustedFor) and share one
  // knowledge repo only group admins may edit. System admins create groups +
  // assign group admins via the admin API; group admins self-serve here.

  const isGroupMember = (userId: string, groupId: string) =>
    store.groupRoleFor(userId, groupId) !== null;
  /** A group admin OR a system admin may manage a group's members/repo. */
  const canManageGroup = (userId: string, groupId: string) =>
    store.isAdmin(userId) || store.isGroupAdmin(userId, groupId);

  // The current user's groups, each with its member roster — members discover &
  // chat with teammates' avatars (now auto-trusted via group co-membership).
  app.get("/api/me/groups", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groups = store.listUserGroups(req.user!.id).map((g) => {
      const repo = store.getGroupKnowledgeRepo(g.id);
      return {
        ...g,
        knowledgeRepo: repo.repo,
        knowledgeBranch: repo.branch,
        knowledgeSelected: repo.selected,
        members: store.listGroupMembers(g.id),
      };
    });
    res.json({ groups });
  });

  // Group admin (or system admin) adds a member by username.
  app.post("/api/me/groups/:id/members", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!store.getGroup(groupId)) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "이 그룹의 멤버를 관리할 권한이 없습니다. (그룹 관리자 전용)");
      return;
    }
    const username = safeString(req.body?.username);
    if (!username) {
      apiError(res, 400, "username이 필요합니다.");
      return;
    }
    const role = req.body?.role === "admin" ? "admin" : "member";
    const member = store.addGroupMemberByUsername(groupId, username, role);
    if (!member) {
      apiError(res, 404, "해당 사용자를 찾을 수 없습니다.");
      return;
    }
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "group_member_add",
      status: "success",
      detail: `group=${groupId} +${member.userId} (${role})`,
    });
    res.json({ member });
  });

  // Change a member's role within the group (promote/demote group admin).
  app.patch("/api/me/groups/:id/members/:userId", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "이 그룹의 멤버를 관리할 권한이 없습니다.");
      return;
    }
    const role = req.body?.role === "admin" ? "admin" : "member";
    const member = store.setGroupMemberRole(groupId, req.params.userId, role);
    if (!member) {
      apiError(res, 404, "멤버를 찾을 수 없습니다.");
      return;
    }
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "group_member_role",
      status: "success",
      detail: `group=${groupId} ${req.params.userId} -> ${role}`,
    });
    res.json({ member });
  });

  // Remove a member from the group.
  app.delete("/api/me/groups/:id/members/:userId", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "이 그룹의 멤버를 관리할 권한이 없습니다.");
      return;
    }
    const removed = store.removeGroupMember(groupId, req.params.userId);
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "group_member_remove",
      status: "success",
      detail: `group=${groupId} -${req.params.userId}`,
    });
    res.json({ ok: removed });
  });

  // Connect/clear the group's shared knowledge repo (group admin only). Validated
  // like the personal repo: a real owner/repo|URL on the internal GitHub host.
  app.put("/api/me/groups/:id/knowledge-repo", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!store.getGroup(groupId)) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "그룹 관리자만 공용 지식 저장소를 설정할 수 있습니다.");
      return;
    }
    const repoRaw = req.body?.repo;
    if (repoRaw === null || repoRaw === "") {
      const group = store.setGroupKnowledgeRepo(groupId, null, null);
      res.json({ group });
      return;
    }
    const repo = safeString(repoRaw);
    if (!repo || !looksLikeRepo(repo)) {
      apiError(res, 400, "repo는 owner/repo 또는 git/https URL 형식이어야 합니다.");
      return;
    }
    if (!isInternalGitSource(repo, config.githubHost)) {
      apiError(res, 400, `그룹 지식 저장소는 사내 GitHub host(${config.githubHost})에 있어야 합니다.`);
      return;
    }
    const branch = safeString(req.body?.branch) || null;
    const group = store.setGroupKnowledgeRepo(groupId, repo, branch);
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "group_repo_set",
      status: "success",
      detail: `group=${groupId} repo=${repo}`,
    });
    res.json({ group });
  });

  // Choose which group-repo plugins members' avatars load; null = load all.
  app.put("/api/me/groups/:id/knowledge-repo/selected", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "그룹 관리자만 설정할 수 있습니다.");
      return;
    }
    if (!store.getGroupKnowledgeRepo(groupId).repo) {
      apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
      return;
    }
    const raw = req.body?.selected;
    let selected: string[] | null;
    if (raw === null || raw === undefined) {
      selected = null;
    } else if (Array.isArray(raw) && raw.every((s) => typeof s === "string")) {
      selected = raw as string[];
    } else {
      apiError(res, 400, "selected는 문자열 배열이거나 null이어야 합니다.");
      return;
    }
    const group = store.setGroupKnowledgeSelected(groupId, selected);
    res.json({ group });
  });

  // List the group repo's plugins (any member may view). Clones with the viewer's token.
  app.get(
    "/api/me/groups/:id/knowledge-repo/contents",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!isGroupMember(req.user!.id, groupId) && !store.isAdmin(req.user!.id)) {
        apiError(res, 403, "이 그룹의 멤버가 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      try {
        const repoRoot = await ensureGroupClone(ctx);
        res.json({ contents: await inspectRepoContents(repoRoot) });
      } catch (error) {
        apiError(res, 502, `저장소를 가져오지 못했습니다: ${scrubGitError(error)}`);
      }
    },
  );

  app.post(
    "/api/me/groups/:id/knowledge-repo/refresh",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!isGroupMember(req.user!.id, groupId) && !store.isAdmin(req.user!.id)) {
        apiError(res, 403, "이 그룹의 멤버가 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      try {
        const repoRoot = await ensureGroupClone(ctx);
        res.json({ contents: await inspectRepoContents(repoRoot) });
      } catch (error) {
        apiError(res, 502, `새로고침 실패: ${scrubGitError(error)}`);
      }
    },
  );

  // ---- Knowledge (owner's gap inbox: colleague questions to handle) ----

  app.get("/api/me/knowledge/requests", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const status = safeString(req.query.status);
    const allowed = ["open", "resolved"] as const;
    const filter = (allowed as readonly string[]).includes(status)
      ? (status as (typeof allowed)[number])
      : undefined;
    res.json({ requests: store.listKnowledgeRequests(req.user!.id, filter) });
  });

  // Resolve (close) a gap once handled. No body: the avatar learns via plugins,
  // so there's no answer to store — clearing the request is the whole action.
  app.delete(
    "/api/me/knowledge/requests/:id",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const resolved = store.resolveKnowledgeRequest(req.user!.id, req.params.id);
      if (!resolved) {
        apiError(res, 404, "정보 요청을 찾을 수 없습니다.");
        return;
      }
      res.json({ ok: true });
    },
  );

  // ---- Avatar notifications (owner inbox / alarms) ---------------------

  app.get("/api/me/notifications", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ notifications: store.listAvatarNotifications(req.user!.id, req.query.unread === "1") });
  });

  app.post("/api/me/notifications/read-all", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ changed: store.markAllAvatarNotificationsRead(req.user!.id) });
  });

  app.patch("/api/me/notifications/:id/read", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ok = store.markAvatarNotificationRead(req.user!.id, req.params.id);
    if (!ok) {
      apiError(res, 404, "알림을 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  // ---- Routine jobs (owner-scheduled recurring runs) -------------------

  app.get("/api/me/routines", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ routines: store.listRoutineJobs(req.user!.id) });
  });

  app.post("/api/me/routines", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const prompt = safeString(req.body?.prompt);
    if (!prompt) {
      apiError(res, 400, "prompt를 입력해 주세요.");
      return;
    }
    const minuteOfDay = parseTimeToMinute(req.body?.time);
    if (minuteOfDay === null) {
      apiError(res, 400, "time은 HH:MM 형식이어야 합니다.");
      return;
    }
    // Reject non-boolean `enabled` ("true", 1, …) instead of silently coercing
    // it to a parked routine the caller thinks is active.
    if (req.body?.enabled !== undefined && typeof req.body.enabled !== "boolean") {
      apiError(res, 400, "enabled는 boolean이어야 합니다.");
      return;
    }
    const enabled = req.body?.enabled === undefined ? true : (req.body.enabled as boolean);
    const routine = store.createRoutineJob(req.user!.id, { prompt, minuteOfDay, enabled });
    logger.info({ userId: req.user!.id, routineId: routine.id, minuteOfDay }, "routine created");
    res.json({ routine });
  });

  app.patch("/api/me/routines/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const patch: { prompt?: string; minuteOfDay?: number; enabled?: boolean } = {};
    if (typeof req.body?.prompt === "string") {
      const prompt = safeString(req.body.prompt);
      if (!prompt) {
        apiError(res, 400, "prompt를 입력해 주세요.");
        return;
      }
      patch.prompt = prompt;
    }
    if (req.body?.time !== undefined) {
      const minuteOfDay = parseTimeToMinute(req.body.time);
      if (minuteOfDay === null) {
        apiError(res, 400, "time은 HH:MM 형식이어야 합니다.");
        return;
      }
      patch.minuteOfDay = minuteOfDay;
    }
    if (typeof req.body?.enabled === "boolean") {
      patch.enabled = req.body.enabled;
    }
    const routine = store.updateRoutineJob(req.user!.id, req.params.id, patch);
    if (!routine) {
      apiError(res, 404, "루틴을 찾을 수 없습니다.");
      return;
    }
    res.json({ routine });
  });

  app.delete("/api/me/routines/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const removed = store.deleteRoutineJob(req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "루틴을 찾을 수 없습니다.");
      return;
    }
    logger.info({ userId: req.user!.id, routineId: req.params.id }, "routine deleted");
    res.json({ ok: true });
  });

  // Fire a routine immediately (a "test run"), then reschedule its next firing.
  // executeRoutineJob owns the shared overlap guard and outcome recording, so a
  // manual run can never overlap a scheduled firing of the same job.
  app.post("/api/me/routines/:id/run", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const job = store.getRoutineJob(req.user!.id, req.params.id);
    if (!job) {
      apiError(res, 404, "루틴을 찾을 수 없습니다.");
      return;
    }
    if (isRoutineRunning(job.id)) {
      apiError(res, 409, "이미 실행 중인 루틴입니다.");
      return;
    }
    const result = await executeRoutineJob(services, job);
    if (result.skipped) {
      apiError(res, 409, "이미 실행 중인 루틴입니다.");
      return;
    }
    logger.info({ userId: req.user!.id, routineId: job.id, ok: result.ok }, "routine manual run");
    const routine = store.getRoutineJob(req.user!.id, job.id);
    res.json({ ok: result.ok, error: result.error, routine });
  });

  // ---- Discovery -------------------------------------------------------

  app.get("/api/avatars", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ avatars: store.listPublishedAvatars(req.user!.id) });
  });

  app.get("/api/avatars/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const avatar = store.getAvatar(req.user!.id, req.params.id);
    if (!avatar) {
      apiError(res, 404, "아바타를 찾을 수 없습니다.");
      return;
    }
    res.json({ avatar });
  });

  // List the skills an avatar can use, for the chat-screen capabilities panel.
  // Lazily resolves plugin roots (may clone), so it's a separate endpoint hit
  // only when the panel opens — not bundled into the avatar detail above.
  // Visibility mirrors getAvatar: must be a published avatar or the viewer's own.
  app.get("/api/avatars/:id/skills", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const avatar = store.getAvatar(req.user!.id, req.params.id);
    if (!avatar) {
      apiError(res, 404, "아바타를 찾을 수 없습니다.");
      return;
    }
    // The local runtime loads no plugins/skills, so there's nothing to list.
    if (config.agentRuntime === "local") {
      res.json({ skills: [] });
      return;
    }
    const sourced: { path: string; source: string }[] = [];
    // Repo-bundled defaults, loaded for every avatar.
    for (const root of await loadDefaultPluginRoots(config)) {
      sourced.push({ path: root.path, source: "default" });
    }
    // The avatar's own plugins, resolved per-repo so each skill is attributed.
    // Use the owner's internal/external git tokens like the chat path.
    const gitTokens = store.getGitTokens(avatar.id);
    for (const plugin of store.listEnabledPlugins(avatar.id)) {
      try {
        const dir = await syncPluginRepo(avatar.id, plugin, config, false, gitTokens);
        const label = plugin.label ?? plugin.repo;
        for (const root of await resolvePluginRoots(dir, plugin.repo, undefined, plugin.selected)) {
          sourced.push({ path: root, source: label });
        }
      } catch {
        // A plugin that won't clone/resolve just contributes no skills.
      }
    }
    // The avatar's own knowledge repo, so its accumulated skills surface too.
    sourced.push(...(await knowledgeRepoSkillSources(knowledgeRepoContextFor(store, avatar.id, config))));
    res.json({ skills: await listSkillsInRoots(sourced) });
  });

  // ---- Conversations & messages ---------------------------------------

  app.get("/api/conversations", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const avatarId = safeString(req.query.avatarId) || undefined;
    const kindRaw = safeString(req.query.kind);
    const kind = kindRaw === "routine" || kindRaw === "all" ? kindRaw : "chat";
    res.json({ conversations: store.listConversations(req.user!.id, avatarId, kind) });
  });

  app.get("/api/messages", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const conversationId = safeString(req.query.conversationId);
    if (!conversationId) {
      res.json({ messages: [] });
      return;
    }
    res.json({ messages: store.listMessages(req.user!.id, conversationId) });
  });

  app.patch("/api/conversations/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const title = safeString(req.body?.title);
    const conversation = store.renameConversation(req.user!.id, req.params.id, title);
    if (!conversation) {
      apiError(res, 404, "대화를 찾을 수 없습니다.");
      return;
    }
    res.json({ conversation });
  });

  app.delete("/api/conversations/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    // Cancel any in-flight run for this conversation first so it stops streaming
    // and its cancel/error path skips the (now-impossible) message persistence
    // instead of racing the row deletion. (lifecycle-03)
    const active = getActiveRunForConversation(req.user!.id, req.params.id);
    if (active) {
      cancelRun(active.runId, req.user!.id);
    }
    const removed = store.deleteConversation(req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "대화를 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  // ---- Chat (SSE) ------------------------------------------------------

  app.post("/api/chat/stream", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const rawMessage = safeString(req.body?.message);
    const slashExpansion = expandChatSlashCommand(rawMessage);
    if (slashExpansion.error) {
      apiError(res, 400, slashExpansion.error);
      return;
    }
    const message = slashExpansion.message;
    const avatarId = safeString(req.body?.avatarId);
    // Greeting: the owner opened a fresh chat with their own avatar and typed
    // nothing — the avatar speaks first (and reports pending info requests).
    const greeting = req.body?.greeting === true && req.user!.id === avatarId;

    // Validate BEFORE switching to SSE so failures stay plain JSON.
    if (!message && !greeting) {
      apiError(res, 400, "메시지를 입력해 주세요.");
      return;
    }
    if (!avatarId) {
      apiError(res, 400, "avatarId가 필요합니다.");
      return;
    }
    const avatar = store.resolveChatAvatar(req.user!.id, avatarId);
    if (!avatar) {
      apiError(res, 403, "이 아바타와 대화할 수 없습니다.");
      return;
    }
    if (slashExpansion.ownerOnly && req.user!.id !== avatar.id) {
      apiError(res, 403, "이 명령은 내 아바타와의 대화에서만 사용할 수 있습니다.");
      return;
    }

    const suppliedConversationId = safeString(req.body?.conversationId);
    // Reject a supplied id that already belongs to ANOTHER user before any DB
    // write: otherwise touchConversation falls through to an INSERT that hits the
    // conversations PRIMARY KEY and throws (an unhandled rejection on Express 4).
    if (suppliedConversationId) {
      const owner = store.conversationOwner(suppliedConversationId);
      if (owner && owner !== req.user!.id) {
        apiError(res, 409, "사용할 수 없는 대화 ID입니다.");
        return;
      }
    }
    const conversationId = suppliedConversationId || crypto.randomUUID();
    const existingAvatarId = store.getConversationAvatarId(req.user!.id, conversationId);
    if (existingAvatarId && existingAvatarId !== avatar.id) {
      apiError(res, 409, "이 대화는 다른 아바타의 대화입니다.");
      return;
    }
    // A run is already streaming for this conversation. This POST carries a NEW
    // typed message; the old attach-and-replay path would silently swallow it
    // (never persisted, never echoed — the client would only mirror the FIRST
    // turn's answer). Reject so the client surfaces the error and keeps the text
    // in the composer. Reconnecting to WATCH an in-flight run uses the dedicated
    // GET /api/chat/runs/:runId/events path, not a second POST.
    const activeRun = getActiveRunForConversation(req.user!.id, conversationId);
    if (activeRun) {
      apiError(res, 409, "이미 이 대화의 응답을 생성 중입니다. 잠시 후 다시 시도해 주세요.");
      return;
    }

    const runId = crypto.randomUUID();
    const regenerate = req.body?.regenerate === true;
    const chatStart = Date.now();
    if (regenerate) {
      store.dropLastAssistant(req.user!.id, conversationId);
    }
    // Resume the conversation's prior SDK session so the model keeps its context
    // across turns. A greeting is ephemeral (never persisted), and a regenerate
    // re-runs the same turn — both start a fresh session to avoid duplicating
    // history in the transcript.
    const resumeSessionId =
      greeting || regenerate
        ? undefined
        : store.getAgentSessionId(req.user!.id, conversationId) ?? undefined;
    // Inject prior context whenever there's no SDK session to resume. A greeting
    // has none. A regenerate deliberately starts a FRESH session (so the re-run
    // turn isn't duplicated in the transcript) but must STILL carry the
    // conversation so far — otherwise the model answers the regenerated turn
    // blind, AND the fresh session id is then persisted, so every later turn
    // would resume a context-less session too. (chat-01 / lifecycle-02)
    const conversationHistory =
      !greeting && !resumeSessionId
        ? conversationHistoryForPrompt(store.listMessages(req.user!.id, conversationId))
        : [];
    // On regenerate the trailing history entry is the user turn being re-run,
    // which is ALSO re-sent as `message` — drop it so it isn't duplicated.
    if (
      regenerate &&
      conversationHistory.length > 0 &&
      conversationHistory[conversationHistory.length - 1].role === "user"
    ) {
      conversationHistory.pop();
    }
    if (!greeting) {
      store.touchConversation(req.user!.id, conversationId, avatar.id, message);
      if (!regenerate) {
        store.addMessage(conversationId, { role: "user", content: message });
      }
    }
    // The SDK session id this run reports (init event); persisted on success so
    // the next turn can resume it.
    let runSessionId: string | null = null;
    // Accumulate the main-agent text as it streams, so the cancel/error paths can
    // persist the partial the user already watched (not an empty "(중지됨)" stub).
    let streamedText = "";
    logger.info(
      { userId: req.user!.id, avatarId: avatar.id, conversationId, greeting, regenerate },
      "chat stream started",
    );

    const abortController = new AbortController();
    openRun(runId, req.user!.id, { conversationId, avatarId: avatar.id, abortController });
    prepareSse(res);
    if (!attachRunClient(runId, req.user!.id, res)) {
      res.end();
      closeRun(runId);
      return;
    }
    emitRunEvent(runId, "open", { conversationId, avatarId: avatar.id, runId });

    try {
      // Load plugin roots (read-only). The repo-bundled default plugin (knowledge
      // backfill etc.) is loaded for every avatar, ahead of its own plugins, then
      // the avatar's personal knowledge repo (the skills/knowledge it accumulates).
      // Tolerate clone/resolve fails.
      const pluginWarnings: string[] = [];
      const pluginRoots =
        config.agentRuntime === "local"
          ? []
          : [
              ...(await loadDefaultPluginRoots(config, (warn) => pluginWarnings.push(warn))),
              ...(await loadAvatarPluginRoots(
                avatar.id,
                store.listEnabledPlugins(avatar.id),
                config,
                (warn) => pluginWarnings.push(warn),
                store.getGitTokens(avatar.id),
              )),
              ...(await loadKnowledgeRepoRoots(
                knowledgeRepoContextFor(store, avatar.id, config),
                (warn) => pluginWarnings.push(warn),
              )),
              // Shared knowledge repos of every group the avatar's owner belongs
              // to — so group skills load for all members' chats.
              ...(await loadGroupKnowledgeRepoRoots(
                groupKnowledgeRepoContextsForUser(store, avatar.id, config),
                (warn) => pluginWarnings.push(warn),
              )),
            ];

      // Per-conversation workspace: each chat session gets an isolated cwd, scoped
      // under the avatar so sessions cannot mix files by accident.
      const workspaceDir = workspaceDirFor(config, avatar.id, conversationId);
      fs.mkdirSync(workspaceDir, { recursive: true });

      for (const warn of pluginWarnings) {
        emitRunEvent(runId, "status", { label: `플러그인 경고: ${warn}` });
      }

      const response = await runAgentStream(
        {
          message,
          avatar: { id: avatar.id, displayName: avatar.displayName, alias: avatar.alias, persona: avatar.persona },
          cwd: workspaceDir,
          resumeSessionId,
          conversationHistory,
          viewerUserId: req.user!.id,
          viewerName: req.user!.displayName,
          viewerIsOwner: req.user!.id === avatar.id,
          // Elevated tool permissions for the owner OR a trusted user. The tool
          // gate denies everyone else, so auto-approving the elevated path is safe.
          elevated: req.user!.id === avatar.id || store.isTrustedFor(req.user!.id, avatar.id),
          autoApprove: true,
          greeting,
        },
        pluginRoots,
        config,
        store,
        {
          onDelta: (text) => {
            streamedText += text;
            emitRunEvent(runId, "delta", { text });
          },
          onStatus: (label) => {
            emitRunEvent(runId, "status", { label });
          },
          onModel: (model) => {
            observedModel = model;
          },
          onSessionId: (sessionId) => {
            runSessionId = sessionId;
          },
          onPlugin: (event) => {
            emitRunEvent(runId, "plugin", { status: event.status, name: event.name });
          },
          onToolStart: (event) => {
            emitRunEvent(runId, "tool", event);
          },
          onToolEnd: (event) => {
            emitRunEvent(runId, "tool_end", event);
          },
          onTaskStart: (event) => {
            emitRunEvent(runId, "task", event);
          },
          onTaskUpdate: (event) => {
            emitRunEvent(runId, "task_update", event);
          },
          onTaskEnd: (event) => {
            emitRunEvent(runId, "task_end", event);
          },
          onAgentStart: (event) => {
            emitRunEvent(runId, "agent", event);
          },
          onAgentEnd: (event) => {
            emitRunEvent(runId, "agent_end", event);
          },
          onBlocked: (event) => {
            emitRunEvent(runId, "blocked", event);
          },
          // Interactive permission prompt (owner only — see claudeAgent).
          onPermission: async (requestData) => {
            const requestId = crypto.randomUUID();
            emitRunEvent(runId, "permission", { runId, requestId, ...requestData });
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED) {
              return { behavior: "deny" };
            }
            return (answer as { behavior: "allow" }).behavior === "allow"
              ? { behavior: "allow" }
              : { behavior: "deny" };
          },
          // AskUserQuestion (and other request_user_dialog kinds).
          onQuestion: async (requestData) => {
            const requestId = crypto.randomUUID();
            emitRunEvent(runId, "question", {
              runId,
              requestId,
              dialogKind: requestData.dialogKind,
              payload: requestData.payload,
            });
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED) {
              return { behavior: "cancelled" };
            }
            const reply = answer as { cancelled?: boolean; result?: unknown };
            if (reply?.cancelled) {
              return { behavior: "cancelled" };
            }
            return { behavior: "completed", result: reply?.result };
          },
        },
        abortController,
      );

      // A greeting is ephemeral: it streams to the screen but is NOT persisted,
      // so opening a fresh chat doesn't litter the history with greeting-only
      // conversations. The conversation starts saving on the owner's first real
      // message.
      if (greeting) {
        emitRunEvent(runId, "done", {
          message: {
            role: "assistant",
            content: response.text || response.summary,
            response,
            createdAt: new Date().toISOString(),
          },
          response,
        });
        return;
      }

      // Remember this run's SDK session so the next turn resumes its context.
      if (runSessionId) {
        store.setAgentSessionId(req.user!.id, conversationId, runSessionId);
      }
      // The conversation may have been deleted mid-run; skip persistence (the FK
      // on messages would reject the insert) and just signal completion.
      const assistantMessage =
        store.conversationOwner(conversationId) === req.user!.id
          ? store.addMessage(conversationId, {
              role: "assistant",
              content: response.text || response.summary,
              response,
            })
          : null;
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "chat",
        status: "success",
        detail: `chat with ${avatar.displayName} (${response.runtime})`,
      });
      logger.info(
        { userId: req.user!.id, avatarId: avatar.id, conversationId, runtime: response.runtime, durationMs: Date.now() - chatStart },
        "chat completed",
      );

      emitRunEvent(runId, "done", { message: assistantMessage, response });
    } catch (error) {
      if (isRunCancelled(runId)) {
        if (!greeting) {
          // Clear the persisted SDK session: the aborted run's transcript is
          // incomplete, so the NEXT turn rebuilds context from stored messages
          // (which now include this cancelled turn's user message + partial)
          // instead of resuming a half-written session that omits it. (chat-02)
          store.setAgentSessionId(req.user!.id, conversationId, null);
          // Keep whatever the model already streamed before the stop. The client's
          // finalizeStopped keeps it on screen, so the persisted record must carry
          // it too — otherwise the visible answer is gone on the next reload/revisit.
          const response: AgentResponse = {
            kind: "text",
            runtime: config.agentRuntime,
            summary: "중지됨",
            text: streamedText,
          };
          // Skip the insert if the conversation was deleted mid-run (FK would reject).
          const stopped =
            store.conversationOwner(conversationId) === req.user!.id
              ? store.addMessage(conversationId, {
                  role: "assistant",
                  content: streamedText || "(중지됨)",
                  response,
                })
              : null;
          emitRunEvent(runId, "cancelled", { message: stopped, response });
        } else {
          emitRunEvent(runId, "cancelled", { message: null });
        }
        return;
      }
      // Scrub before logging too: a git auth failure carries the token in its
      // argv (`http.extraHeader`), which pino's `err` serializer would emit.
      const detail = scrubGitError(error);
      logger.error(
        { detail, userId: req.user!.id, avatarId: avatar.id, conversationId, durationMs: Date.now() - chatStart },
        "chat error",
      );
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "chat",
        status: "error",
        detail,
      });
      if (!greeting && store.conversationOwner(conversationId) === req.user!.id) {
        // Clear the session for the same reason as the cancel path (chat-02), and
        // don't discard the partial the user already watched stream — keep it
        // alongside the error so a reload shows what the live view showed.
        store.setAgentSessionId(req.user!.id, conversationId, null);
        const content = streamedText ? `${streamedText}\n\n${detail}` : detail;
        store.addMessage(conversationId, { role: "assistant", content });
      }
      emitRunEvent(runId, "error", { error: detail });
    } finally {
      closeRun(runId);
    }
  });

  app.get("/api/chat/runs", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const conversationId = safeString(req.query.conversationId);
    if (!conversationId) {
      apiError(res, 400, "conversationId가 필요합니다.");
      return;
    }
    res.json({ run: getActiveRunForConversation(req.user!.id, conversationId) });
  });

  app.get("/api/chat/runs/:runId/events", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const runId = safeString(req.params.runId);
    const run = getActiveRun(runId, req.user!.id);
    if (!run) {
      apiError(res, 404, "진행 중인 실행을 찾을 수 없습니다.");
      return;
    }
    const lastEventId = Number(req.get("Last-Event-ID") || req.query.since || 0);
    prepareSse(res);
    if (!attachRunClient(runId, req.user!.id, res, Number.isFinite(lastEventId) ? lastEventId : 0)) {
      res.end();
    }
  });

  app.post("/api/chat/runs/:runId/cancel", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const runId = safeString(req.params.runId);
    if (!cancelRun(runId, req.user!.id)) {
      apiError(res, 404, "진행 중인 실행을 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  // Answer an interactive prompt (permission / AskUserQuestion) raised mid-run.
  // The run stream stays open on a separate request; this delivers the reply.
  app.post("/api/chat/respond", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const runId = safeString(req.body?.runId);
    const requestId = safeString(req.body?.requestId);
    if (!runId || !requestId) {
      apiError(res, 400, "runId와 requestId가 필요합니다.");
      return;
    }
    // The value is consumed by onPermission/onQuestion as an object
    // ({behavior} | {cancelled} | {result}); reject a non-object up front.
    const value = req.body?.value;
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      apiError(res, 400, "응답 형식이 올바르지 않습니다.");
      return;
    }
    const delivered = submitResponse(runId, requestId, req.user!.id, value);
    if (!delivered) {
      apiError(res, 404, "처리할 수 없는 응답입니다(만료되었거나 권한 없음).");
      return;
    }
    res.json({ ok: true });
  });

  // ---- Admin -----------------------------------------------------------

  // System/runtime info: which model the agent is pinned to (config) vs. which
  // one the SDK actually reported on its last run (observed), plus the auth mode
  // and the read-only tool allowlist. Read-only; admin-gated.
  app.get("/api/admin/system", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({
      system: {
        agentRuntime: config.agentRuntime,
        configuredModel: config.anthropicModel ?? null,
        observedModel,
        authMode: config.anthropicApiKey ? "api_key" : "subscription",
        // Whether a subscription OAuth token (claude setup-token) is stored. The
        // raw token is never returned — only whether one is present.
        subscriptionConnected: Boolean(store.getAppSecret(CLAUDE_OAUTH_TOKEN_KEY)),
        // When an ANTHROPIC_API_KEY is set in .env it takes precedence over the
        // stored subscription token; the UI surfaces this so the admin isn't
        // surprised that pasting a token has no effect.
        apiKeyOverride: Boolean(config.anthropicApiKey),
        readOnlyTools: config.readOnlyTools,
        confluenceConfigured: Boolean(config.confluenceUrl),
        hexSshTools: HEX_SSH_TOOL_INFOS,
        hexSshToolPolicy: store.getHexSshToolPolicy(),
        // Self-service signup gating, admin-managed (see PUT /api/admin/signup-mode).
        signupMode: store.getSignupMode(),
        // Admin-selected model override + whether an env ANTHROPIC_MODEL shadows it
        // (env wins, mirroring the API-key-vs-subscription precedence).
        modelOverride: store.getModelOverride(),
        modelEnvLocked: Boolean(config.anthropicModel),
      },
    });
  });

  app.put("/api/admin/hex-ssh-policy", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const policy = parseHexSshToolPolicy(req.body?.policy);
    if (!policy) {
      apiError(res, 400, "hex-ssh 정책 형식이 올바르지 않습니다.");
      return;
    }
    const saved = store.setHexSshToolPolicy(policy);
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "set_hex_ssh_policy",
      status: "success",
      detail: `owner=${saved.owner.length}, trusted=${saved.trusted.length}, colleague=${saved.colleague.length}`,
    });
    logger.warn({ actorId: req.user!.id, policy: saved }, "hex-ssh tool policy changed");
    res.json({ policy: saved });
  });

  // Store/replace the Claude subscription token (`claude setup-token` output).
  // Encrypted at rest in app_config; injected as CLAUDE_CODE_OAUTH_TOKEN into the
  // agent subprocess when no ANTHROPIC_API_KEY is configured (see claudeAgent.ts).
  // Write-only: the token is never echoed back.
  app.put("/api/admin/claude-token", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) {
      apiError(res, 400, "토큰을 입력해 주세요.");
      return;
    }
    if (!token.startsWith("sk-ant-")) {
      apiError(res, 400, "`claude setup-token`이 출력한 토큰(sk-ant-…)을 붙여넣어 주세요.");
      return;
    }
    store.setAppSecret(CLAUDE_OAUTH_TOKEN_KEY, token);
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "set_claude_token",
      status: "success",
      detail: "subscription OAuth token stored",
    });
    logger.info({ actorId: req.user!.id }, "claude subscription token set");
    res.json({ ok: true });
  });

  app.delete("/api/admin/claude-token", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    store.deleteAppSecret(CLAUDE_OAUTH_TOKEN_KEY);
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "clear_claude_token",
      status: "success",
      detail: "subscription OAuth token cleared",
    });
    logger.info({ actorId: req.user!.id }, "claude subscription token cleared");
    res.json({ ok: true });
  });

  app.get("/api/admin/stats", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({ stats: store.adminStats() });
  });

  app.get("/api/admin/users", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({ users: store.listUsers() });
  });

  app.get("/api/admin/users/:id", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const detail = store.adminUserDetail(req.params.id);
    if (!detail) {
      apiError(res, 404, "사용자를 찾을 수 없습니다.");
      return;
    }
    res.json({ user: detail });
  });

  app.delete(
    "/api/admin/users/:id",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      if (req.params.id === req.user!.id) {
        apiError(res, 400, "자기 자신은 삭제할 수 없습니다.");
        return;
      }
      if (store.isAdmin(req.params.id) && store.countAdmins() <= 1) {
        apiError(res, 400, "마지막 관리자 계정은 삭제할 수 없습니다.");
        return;
      }
      const removed = store.deleteUser(req.params.id);
      if (!removed) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "delete_user",
        status: "success",
        detail: `deleted user ${req.params.id}`,
      });
      logger.warn({ actorId: req.user!.id, targetId: req.params.id }, "user deleted");
      // Best-effort on-disk cleanup (the DB rows are already gone). Never throw:
      // a cleanup failure must not turn a successful deletion into a 500. The
      // knowledge clone is a full copy of a possibly-private repo, so removing it
      // matters most; also drop the per-user ssh trust dir and avatar image. (store-03)
      try {
        fs.rmSync(knowledgeClonePath(req.params.id, config), { recursive: true, force: true });
        fs.rmSync(path.dirname(knownHostsPath(req.params.id, config)), { recursive: true, force: true });
        const avatarsDir = avatarDir(config);
        if (fs.existsSync(avatarsDir)) {
          for (const f of fs.readdirSync(avatarsDir)) {
            if (f === req.params.id || f.startsWith(`${req.params.id}.`)) {
              fs.rmSync(path.join(avatarsDir, f), { force: true });
            }
          }
        }
      } catch (err) {
        logger.warn({ err, targetId: req.params.id }, "post-delete disk cleanup failed");
      }
      res.json({ ok: true });
    },
  );

  app.post(
    "/api/admin/users/:id/roles",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const role = safeString(req.body?.role);
      const grant = req.body?.grant === true;
      if (role !== "admin" && role !== "member") {
        apiError(res, 400, "role은 'admin' 또는 'member' 여야 합니다.");
        return;
      }
      // Don't let an admin strip the last admin (or themselves) out of the role —
      // that would lock everyone out of the admin panel.
      if (role === "admin" && !grant) {
        if (req.params.id === req.user!.id) {
          apiError(res, 400, "자기 자신의 관리자 권한은 해제할 수 없습니다.");
          return;
        }
        if (store.isAdmin(req.params.id) && store.countAdmins() <= 1) {
          apiError(res, 400, "마지막 관리자의 권한은 해제할 수 없습니다.");
          return;
        }
      }
      const user = store.setRole(req.params.id, role, grant);
      if (!user) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "set_role",
        status: "success",
        detail: `${grant ? "grant" : "revoke"} ${role} for ${req.params.id}`,
      });
      logger.warn({ actorId: req.user!.id, targetId: req.params.id, role, grant }, "role changed");
      res.json({ user });
    },
  );

  // Admin password reset. Also force-logs-out the target so the old password's
  // sessions can't linger. The actor's own sessions are untouched.
  app.post(
    "/api/admin/users/:id/password",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (password.length < MIN_PASSWORD_LENGTH) {
        apiError(res, 400, "비밀번호는 8자 이상이어야 합니다.");
        return;
      }
      if (!store.setPassword(req.params.id, password)) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      const revoked = store.revokeAllSessions(req.params.id);
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "reset_password",
        status: "success",
        detail: `reset password for ${req.params.id} (revoked ${revoked} sessions)`,
      });
      logger.warn({ actorId: req.user!.id, targetId: req.params.id }, "admin reset password");
      res.json({ ok: true });
    },
  );

  // Suspend / un-suspend (activate) an account. Suspending kills its sessions.
  app.post(
    "/api/admin/users/:id/suspend",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const suspended = req.body?.suspended === true;
      if (suspended && req.params.id === req.user!.id) {
        apiError(res, 400, "자기 자신은 정지할 수 없습니다.");
        return;
      }
      if (suspended && store.isAdmin(req.params.id) && store.countAdmins() <= 1) {
        apiError(res, 400, "마지막 관리자 계정은 정지할 수 없습니다.");
        return;
      }
      const user = store.setSuspended(req.params.id, suspended);
      if (!user) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: suspended ? "suspend_user" : "activate_user",
        status: "success",
        detail: `${suspended ? "suspended" : "activated"} ${req.params.id}`,
      });
      logger.warn({ actorId: req.user!.id, targetId: req.params.id, suspended }, "suspension changed");
      res.json({ user });
    },
  );

  // Force-logout: revoke every active session for a user without changing anything else.
  app.post(
    "/api/admin/users/:id/logout",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      if (!store.getUserById(req.params.id)) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      const revoked = store.revokeAllSessions(req.params.id);
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "force_logout",
        status: "success",
        detail: `revoked ${revoked} sessions for ${req.params.id}`,
      });
      logger.warn({ actorId: req.user!.id, targetId: req.params.id, revoked }, "force logout");
      res.json({ ok: true, revoked });
    },
  );

  // Admin override of an avatar's published visibility (content moderation).
  app.post(
    "/api/admin/users/:id/published",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const published = req.body?.published === true;
      const user = store.setPublishedByAdmin(req.params.id, published);
      if (!user) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: published ? "publish_avatar" : "unpublish_avatar",
        status: "success",
        detail: `${published ? "published" : "unpublished"} avatar ${req.params.id}`,
      });
      logger.warn({ actorId: req.user!.id, targetId: req.params.id, published }, "admin set published");
      res.json({ user });
    },
  );

  // ---- Admin: groups ----------------------------------------------------
  // Only system admins create/delete groups and assign group admins. Group
  // admins then self-serve their group's members + repo via /api/me/groups/*.

  app.get("/api/admin/groups", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({ groups: store.listGroups() });
  });

  app.post("/api/admin/groups", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const name = safeString(req.body?.name);
    if (!name) {
      apiError(res, 400, "그룹 이름이 필요합니다.");
      return;
    }
    const group = store.createGroup({
      name,
      description: safeString(req.body?.description),
      createdBy: req.user!.id,
    });
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "group_create",
      status: "success",
      detail: `created group ${group.id} (${name})`,
    });
    res.json({ group });
  });

  app.get("/api/admin/groups/:id", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const group = store.getGroup(req.params.id);
    if (!group) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    res.json({ group, members: store.listGroupMembers(req.params.id) });
  });

  app.patch("/api/admin/groups/:id", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const patch: { name?: string; description?: string } = {};
    if (typeof req.body?.name === "string") patch.name = req.body.name;
    if (typeof req.body?.description === "string") patch.description = req.body.description;
    const group = store.updateGroup(req.params.id, patch);
    if (!group) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    res.json({ group });
  });

  app.delete("/api/admin/groups/:id", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const removed = store.deleteGroup(req.params.id);
    if (!removed) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "group_delete",
      status: "success",
      detail: `deleted group ${req.params.id}`,
    });
    logger.warn({ actorId: req.user!.id, groupId: req.params.id }, "group deleted");
    res.json({ ok: true });
  });

  app.post(
    "/api/admin/groups/:id/members",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      if (!store.getGroup(req.params.id)) {
        apiError(res, 404, "그룹을 찾을 수 없습니다.");
        return;
      }
      const username = safeString(req.body?.username);
      if (!username) {
        apiError(res, 400, "username이 필요합니다.");
        return;
      }
      const role = req.body?.role === "admin" ? "admin" : "member";
      const member = store.addGroupMemberByUsername(req.params.id, username, role);
      if (!member) {
        apiError(res, 404, "해당 사용자를 찾을 수 없습니다.");
        return;
      }
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "group_member_add",
        status: "success",
        detail: `group=${req.params.id} +${member.userId} (${role})`,
      });
      res.json({ member });
    },
  );

  app.patch(
    "/api/admin/groups/:id/members/:userId",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const role = req.body?.role === "admin" ? "admin" : "member";
      const member = store.setGroupMemberRole(req.params.id, req.params.userId, role);
      if (!member) {
        apiError(res, 404, "멤버를 찾을 수 없습니다.");
        return;
      }
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "group_member_role",
        status: "success",
        detail: `group=${req.params.id} ${req.params.userId} -> ${role}`,
      });
      res.json({ member });
    },
  );

  app.delete(
    "/api/admin/groups/:id/members/:userId",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const removed = store.removeGroupMember(req.params.id, req.params.userId);
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "group_member_remove",
        status: "success",
        detail: `group=${req.params.id} -${req.params.userId}`,
      });
      res.json({ ok: removed });
    },
  );

  // Self-service signup gating: open | closed | approval.
  app.put("/api/admin/signup-mode", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const mode = safeString(req.body?.mode);
    if (mode !== "open" && mode !== "closed" && mode !== "approval") {
      apiError(res, 400, "mode는 'open' · 'closed' · 'approval' 중 하나여야 합니다.");
      return;
    }
    store.setSignupMode(mode);
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "set_signup_mode",
      status: "success",
      detail: `signup mode = ${mode}`,
    });
    logger.warn({ actorId: req.user!.id, mode }, "signup mode changed");
    res.json({ signupMode: mode });
  });

  // Admin-selected agent model. An env ANTHROPIC_MODEL still wins at runtime
  // (claudeAgent.ts) — the UI surfaces that so the admin isn't surprised.
  app.put("/api/admin/model", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const model = safeString(req.body?.model);
    if (!model) {
      apiError(res, 400, "모델 이름을 입력해 주세요.");
      return;
    }
    store.setModelOverride(model);
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "set_model_override",
      status: "success",
      detail: `model override = ${model}`,
    });
    logger.warn({ actorId: req.user!.id, model }, "model override set");
    res.json({ modelOverride: model });
  });

  app.delete("/api/admin/model", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    store.clearModelOverride();
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action: "clear_model_override",
      status: "success",
      detail: "model override cleared",
    });
    logger.info({ actorId: req.user!.id }, "model override cleared");
    res.json({ ok: true });
  });

  // ---- Audit -----------------------------------------------------------

  app.get("/api/audit", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const isAdmin = req.user!.roles.includes("admin");
    res.json({ audit: store.listAudit(req.user!.id, isAdmin) });
  });

  // ---- Error handler ------------------------------------------------------

  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, method: req.method, path: req.path, userId: (req as AuthenticatedRequest).user?.id ?? null }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  // ---- SPA catch-all ---------------------------------------------------

  app.get("*", (_req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "index.html"));
  });

  return app;
}

export type { AgentResponse };
