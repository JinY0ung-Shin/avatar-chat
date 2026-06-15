import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig, AgentImageInput, ImageMediaType, MessageAttachment } from "./types.js";

/**
 * Chat image attachments (user-uploaded images fed to the model + rendered in
 * the bubble). Mirrors the avatar-image storage pattern (base64 data URL in, a
 * file on disk out), but scoped per conversation under the data volume so it
 * survives restarts and is swept with the conversation. The bytes are NEVER
 * stored in SQLite — only the {@link MessageAttachment} metadata is, on the
 * message row. See `routes/chat.ts` for the upload + serving wiring.
 */

/** Per-image byte cap (after the client's downscale). */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
/** Max images per single user message. */
export const MAX_CHAT_IMAGES_PER_MESSAGE = 6;

const MIME_EXT: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const EXT_MIME: Record<string, ImageMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

// Accept only safe id segments (UUID-ish) so a client-supplied id can't escape
// the conversation's image directory or collide with another file kind.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_CONVERSATION_DIR = /^[A-Za-z0-9_-]{1,128}$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/;

function safeConversationDir(conversationId: string): string {
  if (SAFE_CONVERSATION_DIR.test(conversationId)) return conversationId;
  const hash = crypto.createHash("sha256").update(conversationId).digest("hex");
  return `conversation-${hash}`;
}

export function chatImagesDir(config: AppConfig, conversationId: string): string {
  return path.join(config.dataDir, "chat-images", safeConversationDir(conversationId));
}

/** A decoded, validated upload ready to be written + fed to the model. */
export interface DecodedChatImage {
  id: string;
  mediaType: ImageMediaType;
  ext: string;
  name?: string;
  buffer: Buffer;
}

export type DecodeError =
  | "TOO_MANY"
  | "BAD_FORMAT"
  | "DECODE_FAILED"
  | "EMPTY"
  | "TOO_LARGE";

/**
 * Validate + decode the raw image payloads from a chat POST. Each entry is
 * either a bare data URL string or `{ id?, name?, data }`. Returns the decoded
 * images or the first error encountered (so the caller can reject before
 * switching the response to SSE). An empty/absent list returns `[]`.
 */
export function decodeChatImages(raw: unknown): { images: DecodedChatImage[] } | { error: DecodeError } {
  if (raw == null) return { images: [] };
  if (!Array.isArray(raw)) return { error: "BAD_FORMAT" };
  if (raw.length === 0) return { images: [] };
  if (raw.length > MAX_CHAT_IMAGES_PER_MESSAGE) return { error: "TOO_MANY" };

  const images: DecodedChatImage[] = [];
  for (const entry of raw) {
    const dataUrl = typeof entry === "string" ? entry : typeof entry?.data === "string" ? entry.data : "";
    const rawId = typeof entry === "object" && entry && typeof entry.id === "string" ? entry.id : "";
    const rawName = typeof entry === "object" && entry && typeof entry.name === "string" ? entry.name : "";
    const match = DATA_URL.exec(dataUrl);
    if (!match) return { error: "BAD_FORMAT" };
    const mediaType = match[1] as ImageMediaType;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(match[2], "base64");
    } catch {
      return { error: "DECODE_FAILED" };
    }
    if (buffer.length === 0) return { error: "EMPTY" };
    if (buffer.length > MAX_CHAT_IMAGE_BYTES) return { error: "TOO_LARGE" };
    images.push({
      id: SAFE_ID.test(rawId) ? rawId : crypto.randomUUID(),
      mediaType,
      ext: MIME_EXT[mediaType],
      name: rawName ? rawName.slice(0, 200) : undefined,
      buffer,
    });
  }
  return { images };
}

/**
 * Persist decoded images to the conversation's image directory and return the
 * metadata (for the stored message) plus the model-facing blocks (base64). Ids
 * are de-duplicated against this batch so two uploads can't clobber one file.
 */
export function saveChatImages(
  config: AppConfig,
  conversationId: string,
  decoded: DecodedChatImage[],
): { attachments: MessageAttachment[]; images: AgentImageInput[] } {
  if (decoded.length === 0) return { attachments: [], images: [] };
  const dir = chatImagesDir(config, conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const attachments: MessageAttachment[] = [];
  const images: AgentImageInput[] = [];
  const seen = new Set<string>();
  for (const img of decoded) {
    let id = img.id;
    while (seen.has(id)) id = crypto.randomUUID();
    seen.add(id);
    fs.writeFileSync(path.join(dir, `${id}.${img.ext}`), img.buffer);
    attachments.push({ id, kind: "image", mediaType: img.mediaType, name: img.name });
    images.push({ mediaType: img.mediaType, data: img.buffer.toString("base64") });
  }
  return { attachments, images };
}

/**
 * Read stored attachment files back into model-facing image blocks — used on
 * regenerate (a fresh SDK session that must re-feed the prior turn's images).
 * Silently skips any attachment whose file is missing.
 */
export function readChatImages(
  config: AppConfig,
  conversationId: string,
  attachments: MessageAttachment[] | undefined,
): AgentImageInput[] {
  if (!attachments?.length) return [];
  const out: AgentImageInput[] = [];
  for (const att of attachments) {
    const resolved = resolveStoredImage(config, conversationId, att.id);
    if (!resolved) continue;
    try {
      out.push({ mediaType: resolved.mediaType, data: fs.readFileSync(resolved.path).toString("base64") });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/**
 * Locate a stored image by id within a conversation (for the serving endpoint).
 * Scans the dir for `<id>.<ext>` so the caller needn't know the extension.
 * Returns null on a bad id or when no file exists.
 */
export function resolveStoredImage(
  config: AppConfig,
  conversationId: string,
  imageId: string,
): { path: string; mediaType: ImageMediaType } | null {
  if (!SAFE_ID.test(imageId)) return null;
  const dir = chatImagesDir(config, conversationId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const file = entries.find((name) => {
    const dot = name.lastIndexOf(".");
    return dot > 0 && name.slice(0, dot) === imageId;
  });
  if (!file) return null;
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const mediaType = EXT_MIME[ext];
  if (!mediaType) return null;
  return { path: path.join(dir, file), mediaType };
}

/** Remove a conversation's entire image directory (on conversation delete). */
export function deleteConversationImages(config: AppConfig, conversationId: string): void {
  fs.rmSync(chatImagesDir(config, conversationId), { recursive: true, force: true });
}
