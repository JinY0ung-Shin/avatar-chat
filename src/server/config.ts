import path from "node:path";
import type { AgentRuntime, AppConfig } from "./types.js";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function parseRuntime(value: string): AgentRuntime {
  return value === "local" ? "local" : "claude";
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const dataDir = overrides.dataDir ?? env("APP_DATA_DIR", path.join(process.cwd(), "data"));

  const sessionSecret =
    overrides.sessionSecret ?? env("SESSION_SECRET", isProduction ? "" : "dev-session-secret");
  if (!sessionSecret && isProduction) {
    throw new Error("SESSION_SECRET is required in production.");
  }

  const readOnlyTools = env("READONLY_TOOLS", "Read,Glob,Grep")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  return {
    port: Number(env("PORT", "48787")),
    dataDir,
    dbPath: path.join(dataDir, "noah-almighty.db"),
    sessionSecret,
    agentRuntime: parseRuntime(env("AGENT_RUNTIME", "claude")),
    anthropicApiKey: env("ANTHROPIC_API_KEY") || undefined,
    anthropicModel: env("ANTHROPIC_MODEL") || undefined,
    readOnlyTools,
    githubToken: env("GITHUB_TOKEN") || undefined,
    logLevel: env("LOG_LEVEL", isProduction ? "info" : "debug"),
    // Repo-bundled default skills, loaded for every avatar. cwd-based to match
    // dataDir; cwd is the app root under both `tsx` (dev) and `node dist` (prod).
    defaultPluginsDir: env("DEFAULT_PLUGINS_DIR", path.join(process.cwd(), "default-skills")),
    // SDK session transcripts (the subprocess's CLAUDE_CONFIG_DIR). Under dataDir
    // so a conversation's resumable session survives a server/container restart.
    agentSessionsDir: path.join(dataDir, "agent-sessions"),
    // Generous default: tool/skill/subagent-heavy replies blow past a handful of
    // turns. Override via MAX_TURNS; values <1 fall back to the default.
    maxTurns: Math.max(1, Number(env("MAX_TURNS", "200")) || 200),
    // Installed into the image at build time and exposed under this fixed name
    // (see Dockerfile). Override with HEX_SSH_COMMAND when the global bin isn't
    // available (e.g. local dev).
    hexSshCommand: env("HEX_SSH_COMMAND", "hex-ssh-mcp"),
    ...overrides,
    // dbPath + agentSessionsDir derive from dataDir; recompute if dataDir was
    // overridden but they weren't.
    ...(overrides.dataDir && !overrides.dbPath
      ? { dbPath: path.join(overrides.dataDir, "noah-almighty.db") }
      : {}),
    ...(overrides.dataDir && !overrides.agentSessionsDir
      ? { agentSessionsDir: path.join(overrides.dataDir, "agent-sessions") }
      : {}),
  };
}
