import crypto from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CanvasControl } from "../types.js";
import type { CanvasRequest, CanvasResult } from "./events.js";
import { text } from "./mcpTools.js";

/** MCP server name; the tool surfaces to the model as `mcp__canvas__show`. */
export const CANVAS_SERVER_NAME = "canvas";

/** Tool names the model may call, in `allowedTools` form. */
export const CANVAS_TOOL_NAMES = ["mcp__canvas__show"] as const;

/**
 * Context for the canvas tool: a single callback that emits the artifact to the
 * client (over SSE) and resolves with the user's submission. The chat route owns
 * the SSE/`awaitResponse` plumbing; this tool just shapes the request/result.
 * Experimental `canvas` feature (#50) — the avatar NEVER ships executable JS;
 * the client renders sanitized content + real form controls (CSP-safe).
 */
export interface CanvasToolsContext {
  emitCanvas: (request: CanvasRequest) => Promise<CanvasResult>;
}

const controlSchema = z.object({
  type: z.enum(["buttons", "text"]).describe("'buttons' for selectable options, 'text' for a freeform input."),
  id: z.string().describe("Stable identifier; becomes the key in the returned submitted-values object."),
  label: z.string().optional().describe("Label shown above the control."),
  options: z
    .array(
      z.object({
        label: z.string().describe("Button text shown to the user."),
        value: z.string().optional().describe("Value reported on submit; defaults to the label."),
        description: z.string().optional().describe("Optional helper text under the option."),
      }),
    )
    .optional()
    .describe("For type='buttons': the selectable options."),
  multiSelect: z.boolean().optional().describe("For type='buttons': allow selecting more than one option."),
  placeholder: z.string().optional().describe("For type='text': placeholder text."),
  multiline: z.boolean().optional().describe("For type='text': render a multi-line textarea."),
});

/** Render the user's submitted values back into text the model can read. */
function formatSubmission(values: Record<string, unknown>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return "The user submitted the canvas with no values.";
  }
  const lines = entries.map(([id, value]) => {
    const rendered = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    return `- ${id}: ${rendered}`;
  });
  return `The user responded on the canvas:\n${lines.join("\n")}`;
}

/**
 * Build the canvas tool. INTENTIONALLY NOT self-gated (unlike the owner-only MCP
 * servers): showing UI grants no elevation, the panel is read-only display + form
 * input, and the server only REGISTERS this server when the owner enabled the
 * `canvas` feature AND an interactive `events.onCanvas` sink exists (claudeAgent.ts)
 * — that registration gate is the boundary. Same posture as the deliberately
 * ungated avatarDirectory/sshTrust servers; don't add a viewer gate here.
 */
export function buildCanvasTools(ctx: CanvasToolsContext) {
  return [
    tool(
      "show",
      "Show a visual canvas to the user in the chat side panel (experimental). Use it to share a diagram, mockup, layout, or option comparison and refine it together — not to repeat text the chat could already render. " +
        "Set contentType to one of: 'markdown' (rich text), 'svg' (an inline <svg> diagram), 'html' (static HTML, sanitized), or 'mermaid' (a Mermaid diagram — pass ONLY the diagram source as content). " +
        "Never include scripts or executable JS in content; it is sanitized away. " +
        "To collect a decision, pass `controls` (buttons and/or text inputs): the tool then WAITS and returns the user's submission. With no controls it just displays and returns immediately. The client renders real form controls, so do not ask the user to type their choice into chat when controls can capture it.",
      {
        title: z.string().describe("Short title shown atop the canvas panel."),
        content: z.string().describe("The artifact body, interpreted per contentType."),
        contentType: z
          .enum(["markdown", "svg", "html", "mermaid"])
          .describe("How to render content."),
        controls: z.array(controlSchema).optional().describe("Optional interactive controls to collect a response."),
      },
      async (args) => {
        const controls = (args.controls ?? []) as CanvasControl[];
        const awaitInput = controls.length > 0;
        const result = await ctx.emitCanvas({
          artifactId: crypto.randomUUID(),
          title: args.title,
          content: args.content,
          contentType: args.contentType,
          controls: awaitInput ? controls : undefined,
          awaitInput,
        });
        if (result.behavior === "submitted") {
          return text(formatSubmission(result.values));
        }
        if (result.behavior === "cancelled") {
          return text("The user dismissed the canvas without responding. Proceed without a selection.");
        }
        return text("The canvas was shown to the user.");
      },
    ),
  ];
}

/** Build the in-process MCP server exposing the canvas tool for one run. */
export function buildCanvasServer(ctx: CanvasToolsContext) {
  return createSdkMcpServer({
    name: CANVAS_SERVER_NAME,
    version: "0.1.0",
    tools: buildCanvasTools(ctx),
  });
}
