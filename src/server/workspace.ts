import crypto from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./types.js";

function safeSegment(value: string, fallback: string): string {
  const raw = value.trim() || fallback;
  const readable = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}

export function workspaceDirFor(config: AppConfig, avatarId: string, conversationId: string): string {
  return path.join(
    config.dataDir,
    "workspaces",
    safeSegment(avatarId, "avatar"),
    safeSegment(conversationId, "conversation"),
  );
}
