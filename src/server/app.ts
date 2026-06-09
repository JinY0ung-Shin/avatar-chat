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
import { loadAvatarPluginRoots } from "./plugins.js";
import { Store } from "./store.js";
import type { AgentResponse, AppConfig } from "./types.js";
import { runAgentStream } from "./agent/index.js";

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
    res.json({ user });
  });

  app.post("/api/auth/logout", (req, res) => {
    store.revokeSession(sessionTokenFromRequest(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // First-run probe: when no account exists yet, the client shows the
  // admin-account setup screen instead of the normal login.
  app.get("/api/bootstrap", (_req, res) => {
    res.json({ needsSetup: !store.hasAnyUser() });
  });

  app.get("/api/me", (req, res) => {
    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    res.json({ user });
  });

  // ---- Profile ---------------------------------------------------------

  app.patch("/api/me", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const patch: { displayName?: string; bio?: string; persona?: string; published?: boolean } = {};
    if (typeof req.body?.displayName === "string") patch.displayName = req.body.displayName;
    if (typeof req.body?.bio === "string") patch.bio = req.body.bio;
    if (typeof req.body?.persona === "string") patch.persona = req.body.persona;
    if (typeof req.body?.published === "boolean") patch.published = req.body.published;
    const user = store.updateProfile(req.user!.id, patch);
    res.json({ user });
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
    res.json({ plugin });
  });

  app.patch("/api/me/plugins/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    if (typeof req.body?.enabled !== "boolean") {
      apiError(res, 400, "enabled(boolean)가 필요합니다.");
      return;
    }
    const plugin = store.setPluginEnabled(req.user!.id, req.params.id, req.body.enabled);
    if (!plugin) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    res.json({ plugin });
  });

  app.delete("/api/me/plugins/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const removed = store.deletePlugin(req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
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

    // Validate BEFORE switching to SSE so failures stay plain JSON.
    if (!message) {
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
    const regenerate = req.body?.regenerate === true;
    if (regenerate) {
      store.dropLastAssistant(req.user!.id, conversationId);
    }

    // Load the avatar's enabled plugin roots (read-only). Tolerate clone fails.
    const pluginWarnings: string[] = [];
    const pluginRoots =
      config.agentRuntime === "local"
        ? []
        : await loadAvatarPluginRoots(
            avatar.id,
            store.listEnabledPlugins(avatar.id),
            config,
            (warn) => pluginWarnings.push(warn),
          );

    // Per-avatar workspace: the SDK runs in this directory so the avatar's file
    // reads are scoped here, not to the server tree / other avatars' data.
    const workspaceDir = path.join(config.dataDir, "workspaces", avatar.id);
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
      cleanup();
    });

    sseSend(res, "open", { conversationId, avatarId: avatar.id });
    for (const warn of pluginWarnings) {
      sseSend(res, "status", { label: `플러그인 경고: ${warn}` });
    }

    try {
      const response = await runAgentStream(
        {
          message,
          avatar: { id: avatar.id, displayName: avatar.displayName, persona: avatar.persona },
          cwd: workspaceDir,
        },
        pluginRoots,
        config,
        {
          onDelta: (text) => {
            if (!closed) sseSend(res, "delta", { text });
          },
          onStatus: (label) => {
            if (!closed) sseSend(res, "status", { label });
          },
          onPlugin: (event) => {
            if (!closed) sseSend(res, "plugin", { status: event.status, name: event.name });
          },
          onTool: (name) => {
            if (!closed) sseSend(res, "tool", { name });
          },
        },
        abortController,
      );

      // Client disconnected mid-run: abandon — do not persist.
      if (closed) {
        return;
      }

      store.touchConversation(req.user!.id, conversationId, avatar.id, message);
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

      sseSend(res, "done", { message: assistantMessage, response });
    } catch (error) {
      if (closed) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      store.audit({
        actorUserId: req.user!.id,
        actorName: req.user!.username,
        action: "chat",
        status: "error",
        detail,
      });
      sseSend(res, "error", { error: detail });
    } finally {
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // ---- Admin -----------------------------------------------------------

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
      res.json({ user });
    },
  );

  // ---- Audit -----------------------------------------------------------

  app.get("/api/audit", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const isAdmin = req.user!.roles.includes("admin");
    res.json({ audit: store.listAudit(req.user!.id, isAdmin) });
  });

  // ---- SPA catch-all ---------------------------------------------------

  app.get("*", (_req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "index.html"));
  });

  return app;
}

export type { AgentResponse };
