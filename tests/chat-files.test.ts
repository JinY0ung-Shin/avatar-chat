import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig, MessageAttachment } from "../src/server/types.js";
import {
  chatFilesDir,
  deleteChatFileAttachments,
  deleteConversationFiles,
  publishWorkspaceFile,
  resolveStoredFile,
  sanitizeDownloadName,
  MAX_CHAT_FILE_BYTES,
} from "../src/server/chatFiles.js";
import { withTempDir } from "./helpers.js";

// Minimal OOXML-ish container: the zip local-file-header magic + padding.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PPTX_BYTES = Buffer.concat([ZIP_MAGIC, Buffer.alloc(64, 1)]);

describe("chatFiles", () => {
  const dir = withTempDir("chat-files");
  const config = () => ({ dataDir: dir() }) as AppConfig;
  const workspace = (name = "ws") => {
    const p = path.join(dir(), name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  describe("publishWorkspaceFile", () => {
    it("copies a workspace pptx into the conversation store with download metadata", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "deck.pptx"), PPTX_BYTES);

      const result = publishWorkspaceFile(config(), "conv1", "deck.pptx", [ws]);
      expect("attachment" in result).toBe(true);
      if (!("attachment" in result)) return;
      expect(result.attachment).toMatchObject({
        kind: "file",
        mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        name: "deck.pptx",
        size: PPTX_BYTES.length,
      });

      const resolved = resolveStoredFile(config(), "conv1", result.attachment.id);
      expect(resolved).not.toBeNull();
      expect(resolved!.mediaType).toContain("presentationml");
      expect(fs.readFileSync(resolved!.path).equals(PPTX_BYTES)).toBe(true);
    });

    it("honors a requested download name and keeps the real extension", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "deck.pptx"), PPTX_BYTES);
      const result = publishWorkspaceFile(config(), "conv1", "deck.pptx", [ws], "주간 보고");
      expect("attachment" in result && result.attachment.name).toBe("주간 보고.pptx");
    });

    it("rejects extensions outside the allowlist", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "tool.exe"), ZIP_MAGIC);
      expect(publishWorkspaceFile(config(), "conv1", "tool.exe", [ws])).toEqual({ error: "UNSUPPORTED" });
    });

    it("rejects a container format whose bytes don't match the extension", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "fake.pptx"), Buffer.from("just text"));
      expect(publishWorkspaceFile(config(), "conv1", "fake.pptx", [ws])).toEqual({ error: "UNSUPPORTED" });
    });

    it("accepts plain-text formats without a magic check", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "notes.md"), "# 회의록");
      const result = publishWorkspaceFile(config(), "conv1", "notes.md", [ws]);
      expect("attachment" in result && result.attachment.mediaType).toBe("text/markdown");
    });

    it("refuses paths that escape the allowed roots", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(dir(), "outside.pptx"), PPTX_BYTES);
      expect(publishWorkspaceFile(config(), "conv1", "../outside.pptx", [ws])).toEqual({
        error: "OUTSIDE_WORKSPACE",
      });
      expect(publishWorkspaceFile(config(), "conv1", "deck.pptx", [])).toEqual({ error: "OUTSIDE_WORKSPACE" });
    });

    it("maps missing/empty/oversized files to their errors", () => {
      const ws = workspace();
      expect(publishWorkspaceFile(config(), "conv1", "ghost.pptx", [ws])).toEqual({ error: "NOT_FOUND" });

      fs.writeFileSync(path.join(ws, "empty.pdf"), "");
      expect(publishWorkspaceFile(config(), "conv1", "empty.pdf", [ws])).toEqual({ error: "EMPTY" });

      fs.writeFileSync(
        path.join(ws, "big.pdf"),
        Buffer.concat([Buffer.from("%PDF"), Buffer.alloc(MAX_CHAT_FILE_BYTES, 0)]),
      );
      expect(publishWorkspaceFile(config(), "conv1", "big.pdf", [ws])).toEqual({ error: "TOO_LARGE" });
    });
  });

  describe("resolveStoredFile", () => {
    it("rejects unsafe ids and unknown extensions", () => {
      const stored = chatFilesDir(config(), "conv2");
      fs.mkdirSync(stored, { recursive: true });
      fs.writeFileSync(path.join(stored, "abc.pptx"), PPTX_BYTES);
      fs.writeFileSync(path.join(stored, "odd.exe"), ZIP_MAGIC);

      expect(resolveStoredFile(config(), "conv2", "../abc")).toBeNull();
      expect(resolveStoredFile(config(), "conv2", "odd")).toBeNull();
      expect(resolveStoredFile(config(), "conv2", "abc")).not.toBeNull();
    });
  });

  describe("sweeps", () => {
    it("deleteChatFileAttachments removes only kind:'file' entries", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "deck.pptx"), PPTX_BYTES);
      const published = publishWorkspaceFile(config(), "conv3", "deck.pptx", [ws]);
      if (!("attachment" in published)) throw new Error("publish failed");
      const attachments: MessageAttachment[] = [
        published.attachment,
        { id: "img-1", kind: "image", mediaType: "image/png" },
      ];

      deleteChatFileAttachments(config(), "conv3", attachments);
      expect(resolveStoredFile(config(), "conv3", published.attachment.id)).toBeNull();
    });

    it("deleteConversationFiles removes the whole directory", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "deck.pptx"), PPTX_BYTES);
      publishWorkspaceFile(config(), "conv4", "deck.pptx", [ws]);
      expect(fs.existsSync(chatFilesDir(config(), "conv4"))).toBe(true);
      deleteConversationFiles(config(), "conv4");
      expect(fs.existsSync(chatFilesDir(config(), "conv4"))).toBe(false);
    });
  });

  describe("sanitizeDownloadName", () => {
    it("strips separators, control chars, and leading dots but keeps Hangul", () => {
      expect(sanitizeDownloadName("weekly/report.pptx")).toBe("weekly report.pptx");
      expect(sanitizeDownloadName("\uc8fc\uac04\u0000\ubcf4\uace0.pptx")).toBe("\uc8fc\uac04\ubcf4\uace0.pptx");
      expect(sanitizeDownloadName(".hidden")).toBe("hidden");
      expect(sanitizeDownloadName("///")).toBeNull();
      expect(sanitizeDownloadName("  ")).toBeNull();
      expect(sanitizeDownloadName(undefined)).toBeNull();
      // No separator survives, whatever the input shape.
      expect(sanitizeDownloadName("..\\..\\evil.txt")).not.toMatch(/[\\/]/);
    });
  });
});
