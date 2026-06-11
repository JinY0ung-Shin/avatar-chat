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
  inspectRepoContents,
  knowledgeRepoSkillSources,
  listSkillsInRoots,
  loadAvatarPluginRoots,
  loadDefaultPluginRoots,
  loadKnowledgeRepoRoots,
  pluginClonePath,
  resolvePluginRoots,
  syncPluginRepo,
} from "./plugins.js";
import { scrubGitError } from "./marketplace.js";
import { ensureClone, knowledgeRepoContextFor } from "./knowledgeRepo.js";
import { Store } from "./store.js";
import type { AgentResponse, AppConfig, PluginRoot } from "./types.js";
import { runAgentStream } from "./agent/index.js";
import { awaitResponse, closeRun, openRun, submitResponse, CANCELLED } from "./agent/runRegistry.js";
import { executeRoutineJob, isRoutineRunning } from "./scheduler.js";
import { workspaceDirFor } from "./workspace.js";

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

export function createServices(configOverrides: Partial<AppConfig> = {}): AppServices {
  const config = loadConfig(configOverrides);
  const store = new Store(config);
  return { config, store };
}

/** Write a single SSE frame. Returns false if the socket is no longer writable. */
function sseSend(res: Response, event: string, data: unknown): boolean {
  if (res.writableEnded) {
    return false;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

export function createApp(services = createServices()) {
  const { config, store } = services;
  // The model the SDK last reported via its `init` event. Null until the first
  // Claude run reports one; the admin "system info" view surfaces it alongside
  // the configured model so an operator can confirm what actually ran.
  let observedModel: string | null = null;
  const app = express();
  app.use(express.json({ limit: "3mb" }));
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

  app.post("/api/auth/signup", (req, res) => {
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

  app.post("/api/auth/login", (req, res) => {
    const username = safeString(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = store.verifyLogin(username, password);
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
    res.json({ needsSetup: !store.hasAnyUser(), githubHost: config.githubHost });
  });

  app.get("/api/me", (req, res) => {
    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    res.json({ user });
  });

  // ---- Profile ---------------------------------------------------------

  app.patch("/api/me", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const patch: { displayName?: string; alias?: string; bio?: string; persona?: string; intro?: string; published?: boolean } = {};
    if (typeof req.body?.displayName === "string") patch.displayName = req.body.displayName;
    if (typeof req.body?.alias === "string") patch.alias = req.body.alias;
    if (typeof req.body?.bio === "string") patch.bio = req.body.bio;
    if (typeof req.body?.persona === "string") patch.persona = req.body.persona;
    if (typeof req.body?.intro === "string") patch.intro = req.body.intro;
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
    const gitToken = store.getGitToken(avatar.id);
    const enabledPlugins = store.listEnabledPlugins(avatar.id);
    for (const plugin of enabledPlugins) {
      try {
        const dir = await syncPluginRepo(avatar.id, plugin, config, false, gitToken);
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
      const dir = await syncPluginRepo(req.user!.id, plugin, config, false, store.getGitToken(req.user!.id));
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
      await syncPluginRepo(req.user!.id, plugin, config, true, store.getGitToken(req.user!.id));
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

  // Set (or clear) the user's personal GitHub token. Write-only: the token is
  // never returned — `user.gitTokenSet` reflects whether one is stored.
  app.put("/api/me/git-token", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) {
      apiError(res, 400, "token을 입력해 주세요.");
      return;
    }
    const user = store.setGitToken(req.user!.id, token);
    logger.info({ userId: req.user!.id }, "git token set");
    res.json({ user });
  });

  app.delete("/api/me/git-token", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const user = store.setGitToken(req.user!.id, null);
    logger.info({ userId: req.user!.id }, "git token cleared");
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
    // Use the owner's git token (like the chat path) so private repos resolve.
    const gitToken = store.getGitToken(avatar.id);
    for (const plugin of store.listEnabledPlugins(avatar.id)) {
      try {
        const dir = await syncPluginRepo(avatar.id, plugin, config, false, gitToken);
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
    res.json({ conversations: store.listConversations(req.user!.id, avatarId) });
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
    const removed = store.deleteConversation(req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "대화를 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  // ---- Chat (SSE) ------------------------------------------------------

  app.post("/api/chat/stream", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const message = safeString(req.body?.message);
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

    const conversationId = safeString(req.body?.conversationId) || crypto.randomUUID();
    const existingAvatarId = store.getConversationAvatarId(req.user!.id, conversationId);
    if (existingAvatarId && existingAvatarId !== avatar.id) {
      apiError(res, 409, "이 대화는 다른 아바타의 대화입니다.");
      return;
    }
    const runId = crypto.randomUUID();
    openRun(runId, req.user!.id);
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
    // The SDK session id this run reports (init event); persisted on success so
    // the next turn can resume it.
    let runSessionId: string | null = null;
    logger.info(
      { userId: req.user!.id, avatarId: avatar.id, conversationId, greeting, regenerate },
      "chat stream started",
    );

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
              store.getGitToken(avatar.id),
            )),
            ...(await loadKnowledgeRepoRoots(
              knowledgeRepoContextFor(store, avatar.id, config),
              (warn) => pluginWarnings.push(warn),
            )),
          ];

    // Per-conversation workspace: each chat session gets an isolated cwd, scoped
    // under the avatar so sessions cannot mix files by accident.
    const workspaceDir = workspaceDirFor(config, avatar.id, conversationId);
    fs.mkdirSync(workspaceDir, { recursive: true });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let closed = false;
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`: ping\n\n`);
      }
    }, 15_000);
    const cleanup = () => clearInterval(heartbeat);
    // Treat only a premature socket close (before we've finished writing) as a
    // client disconnect/Stop. Once the response is done we ignore the close.
    res.on("close", () => {
      if (!res.writableEnded) {
        closed = true;
        abortController.abort();
      }
      // Unpark any blocking permission/question waits so the SDK can unwind.
      closeRun(runId);
      cleanup();
    });

    sseSend(res, "open", { conversationId, avatarId: avatar.id, runId });
    for (const warn of pluginWarnings) {
      sseSend(res, "status", { label: `플러그인 경고: ${warn}` });
    }

    try {
      const response = await runAgentStream(
        {
          message,
          avatar: { id: avatar.id, displayName: avatar.displayName, alias: avatar.alias, persona: avatar.persona },
          cwd: workspaceDir,
          resumeSessionId,
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
            if (!closed) sseSend(res, "delta", { text });
          },
          onStatus: (label) => {
            if (!closed) sseSend(res, "status", { label });
          },
          onModel: (model) => {
            observedModel = model;
          },
          onSessionId: (sessionId) => {
            runSessionId = sessionId;
          },
          onPlugin: (event) => {
            if (!closed) sseSend(res, "plugin", { status: event.status, name: event.name });
          },
          onToolStart: (event) => {
            if (!closed) sseSend(res, "tool", event);
          },
          onToolEnd: (event) => {
            if (!closed) sseSend(res, "tool_end", event);
          },
          onTaskStart: (event) => {
            if (!closed) sseSend(res, "task", event);
          },
          onTaskUpdate: (event) => {
            if (!closed) sseSend(res, "task_update", event);
          },
          onTaskEnd: (event) => {
            if (!closed) sseSend(res, "task_end", event);
          },
          onAgentStart: (event) => {
            if (!closed) sseSend(res, "agent", event);
          },
          onAgentEnd: (event) => {
            if (!closed) sseSend(res, "agent_end", event);
          },
          onBlocked: (event) => {
            if (!closed) sseSend(res, "blocked", event);
          },
          // Interactive permission prompt (owner only — see claudeAgent).
          onPermission: async (requestData) => {
            const requestId = crypto.randomUUID();
            sseSend(res, "permission", { runId, requestId, ...requestData });
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED || closed) {
              return { behavior: "deny" };
            }
            return (answer as { behavior: "allow" }).behavior === "allow"
              ? { behavior: "allow" }
              : { behavior: "deny" };
          },
          // AskUserQuestion (and other request_user_dialog kinds).
          onQuestion: async (requestData) => {
            const requestId = crypto.randomUUID();
            sseSend(res, "question", {
              runId,
              requestId,
              dialogKind: requestData.dialogKind,
              payload: requestData.payload,
            });
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED || closed) {
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

      // Client disconnected mid-run: abandon — do not persist.
      if (closed) {
        return;
      }

      // A greeting is ephemeral: it streams to the screen but is NOT persisted,
      // so opening a fresh chat doesn't litter the history with greeting-only
      // conversations. The conversation starts saving on the owner's first real
      // message.
      if (greeting) {
        sseSend(res, "done", {
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

      store.touchConversation(req.user!.id, conversationId, avatar.id, message);
      // Remember this run's SDK session so the next turn resumes its context.
      if (runSessionId) {
        store.setAgentSessionId(conversationId, runSessionId);
      }
      if (!regenerate) {
        store.addMessage(conversationId, { role: "user", content: message });
      }
      const assistantMessage = store.addMessage(conversationId, {
        role: "assistant",
        content: response.text || response.summary,
        response,
      });
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

      sseSend(res, "done", { message: assistantMessage, response });
    } catch (error) {
      if (closed) {
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
      sseSend(res, "error", { error: detail });
    } finally {
      closeRun(runId);
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }
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
    const delivered = submitResponse(runId, requestId, req.user!.id, req.body?.value);
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
        readOnlyTools: config.readOnlyTools,
      },
    });
  });

  app.get("/api/admin/users", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({ users: store.listUsers() });
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
