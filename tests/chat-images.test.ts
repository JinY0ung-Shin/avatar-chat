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
  publishWorkspaceImage,
  deleteChatImageAttachments,
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

  it("reads multiple attachments back as blocks in attachment order", () => {
    const decoded = decodeChatImages([
      { id: "img-a", data: PNG_URL },
      { id: "img-b", data: PNG_URL },
      { id: "img-c", data: PNG_URL },
    ]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-multi", decoded.images);
    expect(attachments.map((a) => a.id)).toEqual(["img-a", "img-b", "img-c"]);

    // Feed the attachments back in a NON-storage order; output must follow the
    // attachment-list order, not the directory listing order.
    const reordered = [attachments[2], attachments[0], attachments[1]];
    const blocks = readChatImages(config(), "conv-multi", reordered);
    expect(blocks).toHaveLength(3);
    expect(blocks).toEqual([
      { mediaType: "image/png", data: PNG_B64 },
      { mediaType: "image/png", data: PNG_B64 },
      { mediaType: "image/png", data: PNG_B64 },
    ]);
  });

  it("returns [] when the conversation image directory does not exist", () => {
    expect(fs.existsSync(chatImagesDir(config(), "conv-never"))).toBe(false);
    const blocks = readChatImages(config(), "conv-never", [
      { id: "img-x", kind: "image", mediaType: "image/png" },
    ]);
    expect(blocks).toEqual([]);
  });

  it("skips attachments with no file on disk while returning the rest", () => {
    const decoded = decodeChatImages([
      { id: "img-present-1", data: PNG_URL },
      { id: "img-present-2", data: PNG_URL },
    ]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-gap", decoded.images);

    const blocks = readChatImages(config(), "conv-gap", [
      attachments[0],
      { id: "img-missing", kind: "image", mediaType: "image/png" },
      attachments[1],
    ]);
    // Only the two stored attachments come back; the gap is silently dropped.
    expect(blocks).toEqual([
      { mediaType: "image/png", data: PNG_B64 },
      { mediaType: "image/png", data: PNG_B64 },
    ]);
  });

  it("skips an attachment whose stored file has a disallowed extension", () => {
    const decoded = decodeChatImages([{ id: "img-ok", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-ext", decoded.images);

    // Drop a file with an id that isn't backed by an EXT_MIME-known extension.
    const dir = chatImagesDir(config(), "conv-ext");
    fs.writeFileSync(path.join(dir, "img-bad.bmp"), Buffer.from(PNG_B64, "base64"));

    const blocks = readChatImages(config(), "conv-ext", [
      attachments[0],
      { id: "img-bad", kind: "image", mediaType: "image/png" },
    ]);
    // The .bmp file is not in EXT_MIME, so only the valid png returns.
    expect(blocks).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
  });

  it("matches the bytes that resolveStoredImage points to (single-readdir equivalence)", () => {
    const decoded = decodeChatImages([{ id: "img-eq", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-eq", decoded.images);

    const blocks = readChatImages(config(), "conv-eq", attachments);
    expect(blocks).toHaveLength(1);

    const resolved = resolveStoredImage(config(), "conv-eq", "img-eq");
    expect(resolved).toBeTruthy();
    const onDisk = fs.readFileSync(resolved!.path).toString("base64");
    // The block's base64 + media type equal a direct read of the resolved path.
    expect(blocks[0].data).toBe(onDisk);
    expect(blocks[0].mediaType).toBe(resolved!.mediaType);
  });

  it("deletes a conversation's image directory", () => {
    const decoded = decodeChatImages([PNG_URL]);
    if (!("images" in decoded)) throw new Error("expected images");
    saveChatImages(config(), "conv-3", decoded.images);
    expect(fs.existsSync(chatImagesDir(config(), "conv-3"))).toBe(true);
    deleteConversationImages(config(), "conv-3");
    expect(fs.existsSync(chatImagesDir(config(), "conv-3"))).toBe(false);
  });

  it("publishes a workspace PNG with byte-sniffed metadata and removes it individually", () => {
    const workspace = path.join(dir(), "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "result.bin"), Buffer.from(PNG_B64, "base64"));

    const result = publishWorkspaceImage(config(), "conv-output", "result.bin", [workspace], "결과 이미지");
    expect("attachment" in result).toBe(true);
    if (!("attachment" in result)) return;
    expect(result.attachment).toMatchObject({
      kind: "image",
      mediaType: "image/png",
      name: "result.bin",
      caption: "결과 이미지",
    });
    expect(resolveStoredImage(config(), "conv-output", result.attachment.id)).toBeTruthy();

    deleteChatImageAttachments(config(), "conv-output", [result.attachment]);
    expect(resolveStoredImage(config(), "conv-output", result.attachment.id)).toBeNull();
  });

  it("rejects workspace escapes, unsupported bytes, and oversized files", () => {
    const workspace = path.join(dir(), "safe-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(dir(), "outside.png"), Buffer.from(PNG_B64, "base64"));
    fs.writeFileSync(path.join(workspace, "text.png"), "not an image");
    fs.writeFileSync(path.join(workspace, "huge.png"), Buffer.alloc(5 * 1024 * 1024 + 1));

    expect(publishWorkspaceImage(config(), "conv-safe", "../outside.png", [workspace])).toEqual({ error: "OUTSIDE_WORKSPACE" });
    expect(publishWorkspaceImage(config(), "conv-safe", "text.png", [workspace])).toEqual({ error: "UNSUPPORTED" });
    expect(publishWorkspaceImage(config(), "conv-safe", "huge.png", [workspace])).toEqual({ error: "TOO_LARGE" });
  });
});
