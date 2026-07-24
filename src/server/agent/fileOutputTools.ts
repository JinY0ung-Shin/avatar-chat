import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FileOutputRequest, FileOutputResult, ShareFileRequest } from "./events.js";
import { text } from "./mcpTools.js";

export const FILE_OUTPUT_SERVER_NAME = "file_output";
export const FILE_OUTPUT_TOOL_NAMES = [
  "mcp__file_output__show_file",
  "mcp__file_output__share_file",
] as const;

export interface FileOutputToolsContext {
  showFile: (request: FileOutputRequest) => Promise<FileOutputResult>;
  shareFile: (request: ShareFileRequest) => Promise<FileOutputResult>;
}

export function buildFileOutputTools(ctx: FileOutputToolsContext) {
  return [
    tool(
      "show_file",
      "Show a PNG, JPEG, WebP, or GIF file from your current working directory to the user in the chat. " +
        "Use this after you generate or download an image the user should see. Pass the local file path; never put a local path or file:// URL in Markdown because the browser cannot access your filesystem. " +
        "Do NOT call Read to inspect, verify, or prepare an image: show_file validates the image bytes itself, while Read may fail when the active model cannot accept image input. " +
        "If the image is outside the allowed working roots (for example under /tmp), copy it into the current directory with Bash (`cp /tmp/image.png \"$PWD/image.png\"`), then call show_file with `./image.png`. " +
        "The file must be inside the run's working directory or scratch workspace and no larger than 5 MB. A turn can show at most 6 images inline; with `hidden:true` the image is instead published quietly (not rendered in the chat bubble) and the result returns a same-origin URL you can embed in a canvas — use that for slide previews (up to 30 hidden publishes per turn).",
      {
        path: z.string().min(1).max(4096).describe("Image path, relative to the current working directory or absolute inside an allowed working root."),
        caption: z.string().max(300).optional().describe("Optional short description shown below the image."),
        hidden: z
          .boolean()
          .optional()
          .describe("Publish without rendering in the chat bubble; the returned URL can be embedded in a canvas (e.g. `![Slide 1](<url>)`)."),
      },
      async (args) => {
        const result = await ctx.showFile({
          path: args.path,
          caption: args.caption?.trim() || undefined,
          hidden: args.hidden || undefined,
        });
        if (result.behavior === "error") {
          return text(result.message, true);
        }
        if (args.hidden) {
          return text(
            `The image was published without being shown in the chat (attachment id: ${result.attachment.id}). ` +
              `To display it inside a canvas, embed exactly this URL in the canvas markdown: ![](${result.url}) — it only renders same-origin, so never rewrite it.`,
          );
        }
        return text(
          `The image was shown to the user (attachment id: ${result.attachment.id}). Do not repeat it as a local-path Markdown image.`,
        );
      },
    ),
    tool(
      "share_file",
      "Hand a generated document to the user as a DOWNLOAD CARD in the chat. " +
        "Use this whenever you finish producing a file the user should keep — a PPTX deck, PDF, DOCX, XLSX, ZIP, CSV, or Markdown/text file. " +
        "For PPTX/DOCX/XLSX/PDF the server AUTOMATICALLY renders page previews into the card's side panel — do NOT render or publish slide images yourself for delivery. " +
        "Pass the local file path from your working directory; never paste a local path or file:// URL into Markdown, because the browser cannot reach your filesystem and there is NO Bash workaround for delivering files. " +
        "The file must be inside the run's working directory or scratch workspace, at most 30 MB, and its content must match its extension. A turn can share at most 3 files.",
      {
        path: z.string().min(1).max(4096).describe("File path, relative to the current working directory or absolute inside an allowed working root."),
        name: z.string().max(200).optional().describe("Download filename shown to the user (defaults to the file's basename). Keep the correct extension."),
      },
      async (args) => {
        const result = await ctx.shareFile({
          path: args.path,
          name: args.name?.trim() || undefined,
        });
        if (result.behavior === "error") {
          return text(result.message, true);
        }
        const previewNote = result.previews
          ? ` ${result.previews} page preview(s) were rendered automatically into the card's side panel — do not publish slide images yourself.`
          : "";
        return text(
          `The file "${result.attachment.name}" is now available to the user as a download card (attachment id: ${result.attachment.id}).${previewNote} ` +
            "Do not also paste its local path; briefly tell the user the file is ready to download.",
        );
      },
    ),
  ];
}

export function buildFileOutputServer(ctx: FileOutputToolsContext) {
  return createSdkMcpServer({
    name: FILE_OUTPUT_SERVER_NAME,
    version: "1.0.0",
    tools: buildFileOutputTools(ctx),
  });
}
