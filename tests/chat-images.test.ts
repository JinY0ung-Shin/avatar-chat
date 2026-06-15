import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/types.js";
import {
  decodeChatImages,
  saveChatImages,
  readChatImages,
  resolveStoredImage,
  deleteConversationImages,
  chatImagesDir,
  MAX_CHAT_IMAGES_PER_MESSAGE,
} from "../src/server/chatImages.js";
import { withTempDir } from "./helpers.js";

// 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

describe("chatImages", () => {
  const dir = withTempDir("chat-images");
  const config = () => ({ dataDir: dir() }) as AppConfig;

  describe("decodeChatImages", () => {
    it("treats absent/empty input as no images", () => {
      expect(decodeChatImages(undefined)).toEqual({ images: [] });
      expect(decodeChatImages([])).toEqual({ images: [] });
    });

    it("rejects a non-array payload", () => {
      expect(decodeChatImages("nope")).toEqual({ error: "BAD_FORMAT" });
    });

    it("rejects more than the per-message cap", () => {
      const many = Array.from({ length: MAX_CHAT_IMAGES_PER_MESSAGE + 1 }, () => PNG_URL);
      expect(decodeChatImages(many)).toEqual({ error: "TOO_MANY" });
    });

    it("rejects a non-image / malformed data URL", () => {
      expect(decodeChatImages(["data:text/plain;base64,aGk="])).toEqual({ error: "BAD_FORMAT" });
      expect(decodeChatImages(["not-a-data-url"])).toEqual({ error: "BAD_FORMAT" });
    });

    it("rejects an oversized image", () => {
      const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
      expect(decodeChatImages([`data:image/png;base64,${big}`])).toEqual({ error: "TOO_LARGE" });
    });

    it("decodes a valid image and keeps a safe client id", () => {
      const result = decodeChatImages([{ id: "abc-123", name: "shot.png", data: PNG_URL }]);
      expect("images" in result).toBe(true);
      if (!("images" in result)) return;
      expect(result.images).toHaveLength(1);
      expect(result.images[0]).toMatchObject({ id: "abc-123", mediaType: "image/png", ext: "png", name: "shot.png" });
      expect(result.images[0].buffer.length).toBeGreaterThan(0);
    });

    it("replaces an unsafe id with a generated one", () => {
      const result = decodeChatImages([{ id: "../../etc/passwd", data: PNG_URL }]);
      if (!("images" in result)) throw new Error("expected images");
      expect(result.images[0].id).not.toContain("/");
      expect(result.images[0].id.length).toBeGreaterThan(0);
    });
  });

  it("saves images to disk and resolves them back by id", () => {
    const decoded = decodeChatImages([{ id: "img-1", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments, images } = saveChatImages(config(), "conv-1", decoded.images);
    expect(attachments).toEqual([{ id: "img-1", kind: "image", mediaType: "image/png", name: undefined }]);
    expect(images[0]).toEqual({ mediaType: "image/png", data: PNG_B64 });
    // File landed under the conversation's image dir.
    expect(fs.existsSync(path.join(chatImagesDir(config(), "conv-1"), "img-1.png"))).toBe(true);

    const resolved = resolveStoredImage(config(), "conv-1", "img-1");
    expect(resolved?.mediaType).toBe("image/png");
    expect(resolved && fs.existsSync(resolved.path)).toBe(true);
  });

  it("keeps unsafe conversation ids inside the chat-images root", () => {
    const decoded = decodeChatImages([{ id: "img-unsafe", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "../../outside", decoded.images);
    expect(attachments[0].id).toBe("img-unsafe");

    const root = path.join(config().dataDir, "chat-images");
    const resolved = resolveStoredImage(config(), "../../outside", "img-unsafe");
    expect(resolved).toBeTruthy();
    expect(resolved!.path.startsWith(root + path.sep)).toBe(true);
    expect(resolved!.path).not.toContain(`..${path.sep}`);
    expect(fs.existsSync(path.join(config().dataDir, "outside", "img-unsafe.png"))).toBe(false);
  });

  it("rejects a traversal id at resolve time", () => {
    expect(resolveStoredImage(config(), "conv-1", "../../secret")).toBeNull();
    expect(resolveStoredImage(config(), "conv-1", "missing")).toBeNull();
  });

  it("reads stored attachments back into model image blocks", () => {
    const decoded = decodeChatImages([{ id: "img-2", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-2", decoded.images);
    const blocks = readChatImages(config(), "conv-2", attachments);
    expect(blocks).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
    // A missing attachment is skipped, not fatal.
    expect(readChatImages(config(), "conv-2", [{ id: "ghost", kind: "image", mediaType: "image/png" }])).toEqual([]);
  });

  it("deletes a conversation's image directory", () => {
    const decoded = decodeChatImages([PNG_URL]);
    if (!("images" in decoded)) throw new Error("expected images");
    saveChatImages(config(), "conv-3", decoded.images);
    expect(fs.existsSync(chatImagesDir(config(), "conv-3"))).toBe(true);
    deleteConversationImages(config(), "conv-3");
    expect(fs.existsSync(chatImagesDir(config(), "conv-3"))).toBe(false);
  });
});
