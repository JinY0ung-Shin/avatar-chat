import crypto from "node:crypto";
import express, { type Response } from "express";
import path from "node:path";
import { clearSessionCookie, requireAuth, requireOwner, sessionTokenFromRequest, setSessionCookie } from "./auth.js";
import { loadConfig } from "./config.js";
import { loadMarketplaceRegistry, type MarketplaceRegistry } from "./marketplace.js";
import { createMessage, JsonStore } from "./store.js";
import type { AppConfig, ChatMode, DiscoveredPlugin, UserRole } from "./types.js";
import { runAgent, runAgentStream } from "./agent/index.js";
import type { AuthenticatedRequest } from "./auth.js";

export interface AppServices {
  config: AppConfig;
  store: JsonStore;
  getRegistry: () => Promise<MarketplaceRegistry>;
  refreshRegistry: () => Promise<MarketplaceRegistry>;
}

interface MarketplacePluginStatus {
  name: string;
  version: string | null;
  description: string | null;
  commandCount: number;
  tags: string[];
  source: string;
}

interface MarketplaceStatus {
  name: string | null;
  pluginCount: number;
  warnings: string[];
  registryError: string | null;
  plugins: MarketplacePluginStatus[];
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

function describeSource(source: DiscoveredPlugin["source"]): string {
  if (typeof source === "string") {
    return source;
  }
  if (source.repo) {
    return `${source.source}:${source.repo}`;
  }
  if (source.url) {
    return `${source.source}:${source.url}`;
  }
  if (source.package) {
    return `${source.source}:${source.package}`;
  }
  return source.source;
}

function pluginStatus(plugin: DiscoveredPlugin): MarketplacePluginStatus {
  return {
    name: plugin.name,
    version: plugin.version ?? null,
    description: plugin.description ?? null,
    commandCount: plugin.commands.length,
    tags: plugin.tags,
    source: describeSource(plugin.source),
  };
}

async function buildMarketplaceStatus(load: () => Promise<MarketplaceRegistry>): Promise<MarketplaceStatus> {
  try {
    const registry = await load();
    return {
      name: registry.name,
      pluginCount: registry.plugins.length,
      warnings: registry.warnings,
      registryError: null,
      plugins: registry.plugins.map(pluginStatus),
    };
  } catch (error) {
    return {
      name: null,
      pluginCount: 0,
      warnings: [],
      registryError: error instanceof Error ? error.message : String(error),
      plugins: [],
    };
  }
}

export function createServices(configOverrides: Partial<AppConfig> = {}): AppServices {
  const config = loadConfig(configOverrides);
  const store = new JsonStore(config);
  let registryPromise: Promise<MarketplaceRegistry> | null = null;

  const getRegistry = async (): Promise<MarketplaceRegistry> => {
    registryPromise ??= loadMarketplaceRegistry(config);
    return registryPromise;
  };

  const refreshRegistry = async (): Promise<MarketplaceRegistry> => {
    // Reset the cache so the next load (re-clone/re-install) runs fresh. We
    // assign the new promise synchronously so concurrent callers share it.
    const next = loadMarketplaceRegistry(config);
    registryPromise = next;
    try {
      return await next;
    } catch (error) {
      // Clear the rejected cache so a later getRegistry() can retry.
      if (registryPromise === next) {
        registryPromise = null;
      }
      throw error;
    }
  };

  return { config, store, getRegistry, refreshRegistry };
}

/**
 * Write a single SSE frame: `event: <name>\ndata: <json>\n\n`. Returns false if
 * the socket is no longer writable so callers can stop the SDK iteration.
 */
function sseSend(res: Response, event: string, data: unknown): boolean {
  if (res.writableEnded) {
    return false;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

export function createApp(services = createServices()) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/fonts/noto-sans-kr",
    express.static(path.join(process.cwd(), "node_modules", "@fontsource-variable", "noto-sans-kr")),
  );

  // Vendored ES modules the frontend imports directly (no bundler). Mounted as
  // single files so the exact contract paths resolve, and placed before the
  // SPA catch-all so they are never swallowed by index.html.
  app.get("/vendor/marked.esm.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(process.cwd(), "node_modules", "marked", "lib", "marked.esm.js"));
  });
  app.get("/vendor/purify.es.mjs", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(process.cwd(), "node_modules", "dompurify", "dist", "purify.es.mjs"));
  });

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

  app.get("/api/marketplace/status", requireAuth(services.store), async (_req: AuthenticatedRequest, res) => {
    res.json(await buildMarketplaceStatus(services.getRegistry));
  });

  app.post(
    "/api/marketplace/refresh",
    requireAuth(services.store),
    requireOwner,
    async (req: AuthenticatedRequest, res) => {
      const status = await buildMarketplaceStatus(services.refreshRegistry);
      services.store.addAudit({
        actorUserId: req.user?.id ?? "unknown",
        actorName: req.user?.name ?? "unknown",
        mode: "owner",
        action: "marketplace_refresh",
        runtime: "local",
        status: status.registryError ? "error" : "success",
        detail: status.registryError
          ? `Marketplace refresh failed: ${status.registryError}`
          : `Reloaded ${status.pluginCount} plugin(s)`,
      });
      res.json(status);
    },
  );

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

  app.post("/api/chat/stream", requireAuth(services.store), async (req: AuthenticatedRequest, res) => {
    const message = safeString(req.body?.message);
    const requestedMode = validMode(req.body?.mode) ? req.body.mode : "colleague";

    // Validate BEFORE switching to SSE so failures stay plain JSON with the
    // right status code (the contract requires 400/403 JSON, not SSE).
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

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let closed = false;
    // Cancels the SDK run when the client hits Stop or disconnects, so tools
    // stop executing and tokens stop generating server-side (not just hidden).
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`: ping\n\n`);
      }
    }, 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
    };
    req.on("close", () => {
      closed = true;
      abortController.abort();
      cleanup();
    });

    const runtimeHint: "claude" | "local" = services.config.agentRuntime === "local" ? "local" : "claude";
    sseSend(res, "open", { conversationId, runtime: runtimeHint });

    try {
      const response = await runAgentStream(
        {
          message,
          mode: requestedMode,
          user: req.user!,
        },
        registry,
        services.config,
        {
          onDelta: (text) => {
            if (!closed) {
              sseSend(res, "delta", { text });
            }
          },
          onStatus: (label) => {
            if (!closed) {
              sseSend(res, "status", { label });
            }
          },
          onPlugin: (event) => {
            if (!closed) {
              sseSend(res, "plugin", { status: event.status, name: event.name });
            }
          },
          onTool: (name) => {
            if (!closed) {
              sseSend(res, "tool", { name });
            }
          },
        },
        abortController,
      );

      // Client stopped/disconnected mid-run: the run was abandoned, so do not
      // persist a partial assistant message or audit — keep server state in
      // sync with the client's "중지됨" bubble (which is client-local only).
      if (closed) {
        return;
      }

      const assistantMessage = createMessage({
        conversationId,
        userId: req.user?.id ?? "",
        mode: requestedMode,
        role: "assistant",
        content: response.text || response.summary,
        response,
      });
      // Persist user + assistant + audit identically to /api/chat — including
      // the colleague mutating-block case, which is delivered as a single
      // `done` (blocked AgentResponse) rather than a 4xx.
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

      sseSend(res, "done", { message: assistantMessage, response });
    } catch (error) {
      // An abort triggered by client Stop/disconnect surfaces here; treat it as
      // a non-persisting stop so a cancelled run never lands in history/audit.
      if (closed) {
        return;
      }
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
      sseSend(res, "error", { error: detail });
    } finally {
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  app.get("*", (_req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "index.html"));
  });

  return app;
}
