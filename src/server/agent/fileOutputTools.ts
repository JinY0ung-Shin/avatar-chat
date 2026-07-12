import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FileOutputRequest, FileOutputResult } from "./events.js";
import { text } from "./mcpTools.js";

export const FILE_OUTPUT_SERVER_NAME = "file_output";
export const FILE_OUTPUT_TOOL_NAMES = ["mcp__file_output__show_file"] as const;

export interface FileOutputToolsContext {
  showFile: (request: FileOutputRequest) => Promise<FileOutputResult>;
}

export function buildFileOutputTools(ctx: FileOutputToolsContext) {
  return [
    tool(
      "show_file",
      "Show a PNG, JPEG, WebP, or GIF file from your current working directory to the user in the chat. " +
        "Use this after you generate or download an image the user should see. Pass the local file path; never put a local path or file:// URL in Markdown because the browser cannot access your filesystem. " +
        "The file must be inside the run's working directory or scratch workspace, no larger than 5 MB, and a turn can show at most 6 images.",
      {
        path: z.string().min(1).max(4096).describe("Image path, relative to the current working directory or absolute inside an allowed working root."),
        caption: z.string().max(300).optional().describe("Optional short description shown below the image."),
      },
      async (args) => {
        const result = await ctx.showFile({
          path: args.path,
          caption: args.caption?.trim() || undefined,
        });
        if (result.behavior === "error") {
          return text(result.message, true);
        }
        return text(
          `The image was shown to the user (attachment id: ${result.attachment.id}). Do not repeat it as a local-path Markdown image.`,
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
