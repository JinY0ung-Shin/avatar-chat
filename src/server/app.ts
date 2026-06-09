import crypto from "node:crypto";
import express, { type Response } from "express";
import path from "node:path";
import { clearSessionCookie, requireAuth, requireOwner, sessionTokenFromRequest, setSessionCookie } from "./auth.js";
import { loadConfig } from "./config.js";
import { loadMarketplaceRegistry, type MarketplaceRegistry } from "./marketplace.js";
import { createMessage, JsonStore } from "./store.js";
import type { AppConfig, ChatMode, UserRole } from "./types.js";
import { runAgent } from "./agent/index.js";
import type { AuthenticatedRequest } from "./auth.js";

export interface AppServices {
  config: AppConfig;
  store: JsonStore;
  getRegistry: () => Promise<MarketplaceRegistry>;
}

function validMode(value: unknown): value is ChatMode {
  return value === "owner" || value === "colleague";
}

function validRole(value: unknown): value is UserRole {
  return value === "owner" || value === "colleague";
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function apiError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

export function createServices(configOverrides: Partial<AppConfig> = {}): AppServices {
  const config = loadConfig(configOverrides);
  const store = new JsonStore(config);
  let registryPromise: Promise<MarketplaceRegistry> | null = null;

  return {
    config,
    store,
    getRegistry: async () => {
      registryPromise ??= loadMarketplaceRegistry(config);
      return registryPromise;
    },
  };
}

export function createApp(services = createServices()) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/fonts/noto-sans-kr",
    express.static(path.join(process.cwd(), "node_modules", "@fontsource-variable", "noto-sans-kr")),
  );
  app.use(express.static(path.join(process.cwd(), "public")));

  app.get("/api/bootstrap", async (_req, res) => {
    const state = services.store.read();
    let registry: MarketplaceRegistry | null = null;
    let registryError: string | null = null;
    try {
      registry = await services.getRegistry();
    } catch (error) {
      registryError = error instanceof Error ? error.message : String(error);
    }
    res.json({
      hasUsers: state.users.length > 0,
      agentRuntime: services.config.agentRuntime,
      claudeConfigured: Boolean(services.config.anthropicApiKey),
      marketplace: registry
        ? {
            name: registry.name,
            pluginCount: registry.plugins.length,
            warnings: registry.warnings,
          }
        : null,
      registryError,
    });
  });

  app.get("/api/me", (req, res) => {
    const user = services.store.getUserBySessionToken(sessionTokenFromRequest(req));
    res.json({ user });
  });

  app.post("/api/session", (req, res) => {
    const name = safeString(req.body?.name, "익명");
    const code = safeString(req.body?.code);
    if (!code) {
      apiError(res, 400, "Invite code is required.");
      return;
    }

    const result =
      services.store.authenticateOwner(name, code) ?? services.store.authenticateInvite(name, code);
    if (!result) {
      apiError(res, 401, "Invalid or exhausted invite code.");
      return;
    }

    setSessionCookie(res, result.sessionToken);
    services.store.addAudit({
      actorUserId: result.user.id,
      actorName: result.user.name,
      mode: result.user.role === "owner" ? "owner" : "colleague",
      action: "login",
      runtime: "local",
      status: "success",
      detail: `${result.user.role} signed in`,
    });
    res.json({ user: result.user });
  });

  app.post("/api/logout", (req, res) => {
    services.store.revokeSession(sessionTokenFromRequest(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/skills", requireAuth(services.store), async (req: AuthenticatedRequest, res) => {
    const registry = await services.getRegistry();
    const mode = req.user?.role === "owner" ? "owner" : "colleague";
    res.json({
      marketplace: {
        name: registry.name,
        rootPath: registry.rootPath,
        warnings: registry.warnings,
      },
      plugins: registry.plugins.map((plugin) => ({
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        tags: plugin.tags,
        commands: plugin.commands
          .filter((command) => {
            if (mode === "owner") {
              return true;
            }
            return (
              command.readOnly &&
              command.projectScoped === true &&
              (command.mode === "colleague" || command.mode === "both")
            );
          })
          .map((command) => ({
            name: command.name,
            description: command.description,
            mode: command.mode,
            readOnly: command.readOnly,
            projectScoped: command.projectScoped === true,
          })),
      })),
    });
  });

  app.get("/api/invites", requireAuth(services.store), requireOwner, (_req, res) => {
    res.json({ invites: services.store.listInvites() });
  });

  app.post("/api/invites", requireAuth(services.store), requireOwner, (req: AuthenticatedRequest, res) => {
    const label = safeString(req.body?.label, "팀원 초대");
    const role = validRole(req.body?.role) ? req.body.role : "colleague";
    const projectScope = safeString(req.body?.projectScope, req.user?.projectScope ?? "default-project");
    const maxUses = Number(req.body?.maxUses ?? 1);
    const invite = services.store.createInvite({
      label,
      role,
      projectScope,
      maxUses: Number.isFinite(maxUses) ? maxUses : 1,
      createdBy: req.user?.id ?? "unknown",
    });
    services.store.addAudit({
      actorUserId: req.user?.id ?? "unknown",
      actorName: req.user?.name ?? "unknown",
      mode: "owner",
      action: "create_invite",
      runtime: "local",
      status: "success",
      detail: `Created ${role} invite for ${projectScope}`,
    });
    res.json({ invite });
  });

  app.get("/api/audit", requireAuth(services.store), (req: AuthenticatedRequest, res) => {
    const audit = services.store.listAudit();
    if (req.user?.role === "owner") {
      res.json({ audit });
      return;
    }
    res.json({
      audit: audit.filter((event) => event.actorUserId === req.user?.id),
    });
  });

  app.get("/api/messages", requireAuth(services.store), (req: AuthenticatedRequest, res) => {
    const mode = validMode(req.query.mode) ? req.query.mode : undefined;
    res.json({ messages: services.store.listMessagesForUser(req.user?.id ?? "", mode) });
  });

  app.post("/api/chat", requireAuth(services.store), async (req: AuthenticatedRequest, res) => {
    const message = safeString(req.body?.message);
    const requestedMode = validMode(req.body?.mode) ? req.body.mode : "colleague";
    if (!message) {
      apiError(res, 400, "Message is required.");
      return;
    }
    if (requestedMode === "owner" && req.user?.role !== "owner") {
      apiError(res, 403, "Owner mode is only available to the owner.");
      return;
    }

    const registry = await services.getRegistry();
    const conversationId = safeString(req.body?.conversationId) || crypto.randomUUID();
    const userMessage = createMessage({
      conversationId,
      userId: req.user?.id ?? "",
      mode: requestedMode,
      role: "user",
      content: message,
    });

    try {
      const response = await runAgent(
        {
          message,
          mode: requestedMode,
          user: req.user!,
        },
        registry,
        services.config,
      );
      const assistantMessage = createMessage({
        conversationId,
        userId: req.user?.id ?? "",
        mode: requestedMode,
        role: "assistant",
        content: response.text || response.summary,
        response,
      });
      services.store.addMessages([userMessage, assistantMessage]);
      services.store.addAudit({
        actorUserId: req.user?.id ?? "unknown",
        actorName: req.user?.name ?? "unknown",
        mode: requestedMode,
        action: "chat",
        pluginName: response.pluginName,
        skillName: response.skillName,
        runtime: response.runtime,
        status: response.runtime === "blocked" ? "blocked" : "success",
        detail: response.summary,
      });
      res.json({ conversationId, message: assistantMessage, response });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      services.store.addMessages([userMessage]);
      services.store.addAudit({
        actorUserId: req.user?.id ?? "unknown",
        actorName: req.user?.name ?? "unknown",
        mode: requestedMode,
        action: "chat",
        runtime: services.config.agentRuntime === "claude" ? "claude" : "local",
        status: "error",
        detail,
      });
      apiError(res, 500, detail);
    }
  });

  app.get("*", (_req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "index.html"));
  });

  return app;
}
