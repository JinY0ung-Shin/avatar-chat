import path from "node:path";
import type { AgentRuntime, AppConfig } from "./types.js";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function parseRuntime(value: string): AgentRuntime {
  if (value === "claude" || value === "local" || value === "auto") {
    return value;
  }
  return "auto";
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const dataDir = env("APP_DATA_DIR", path.join(process.cwd(), "data"));
  const ownerSetupCode = env(
    "OWNER_SETUP_CODE",
    isProduction ? "" : "owner-local-setup",
  );

  if (!ownerSetupCode && isProduction) {
    throw new Error("OWNER_SETUP_CODE is required in production.");
  }

  return {
    port: Number(env("PORT", "48787")),
    dataDir,
    sessionSecret: env("SESSION_SECRET", isProduction ? "" : "dev-session-secret"),
    ownerSetupCode,
    defaultProjectScope: env("DEFAULT_PROJECT_SCOPE", "default-project"),
    marketplaceSource: env(
      "MARKETPLACE_SOURCE",
      path.join(process.cwd(), "sample-marketplace"),
    ),
    marketplaceRef: env("MARKETPLACE_REF") || undefined,
    githubToken: env("GITHUB_TOKEN") || undefined,
    agentRuntime: parseRuntime(env("AGENT_RUNTIME", "claude")),
    anthropicApiKey: env("ANTHROPIC_API_KEY") || undefined,
    colleagueAllowedTools: env("COLLEAGUE_ALLOWED_TOOLS", "Read,Glob,Grep")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
    ownerPermissionMode: env("OWNER_PERMISSION_MODE", "default"),
    ...overrides,
  };
}
