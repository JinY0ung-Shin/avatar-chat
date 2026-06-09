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
    dbPath: path.join(dataDir, "avatar-chat.db"),
    sessionSecret,
    agentRuntime: parseRuntime(env("AGENT_RUNTIME", "claude")),
    anthropicApiKey: env("ANTHROPIC_API_KEY") || undefined,
    readOnlyTools,
    githubToken: env("GITHUB_TOKEN") || undefined,
    ...overrides,
    // dbPath derives from dataDir; recompute if dataDir overridden but dbPath not.
    ...(overrides.dataDir && !overrides.dbPath
      ? { dbPath: path.join(overrides.dataDir, "avatar-chat.db") }
      : {}),
  };
}
