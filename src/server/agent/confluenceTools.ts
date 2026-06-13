import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AppConfig } from "../types.js";
import { text } from "./mcpTools.js";

export const CONFLUENCE_SERVER_NAME = "confluence";
export const CONFLUENCE_PAT_SECRET_NAME = "CONFLUENCE_PAT";

export const CONFLUENCE_TOOL_NAMES = [
  "mcp__confluence__describe_config",
  "mcp__confluence__list_spaces",
  "mcp__confluence__search",
  "mcp__confluence__get_page",
  "mcp__confluence__create_page",
  "mcp__confluence__update_page",
] as const;

export interface ConfluenceToolsContext {
  /** Deployment config, including the public Confluence base URL. */
  config: AppConfig;
  /** Avatar owner's decrypted secret map; values are never returned. */
  ownerSecrets: Record<string, string>;
  /** True for owner/trusted-user interactive chats. Gates write tools. */
  elevated: boolean;
}

type JsonRecord = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 20_000;
const WRITE_DENIED = "Confluence write tools can only be used in avatar owner or trusted user conversations.";

function asRecord(value: unknown): JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncate(value: string, max = MAX_BODY_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}\n\n[truncated ${value.length - max} chars]` : value;
}

function cqlQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildCql(args: {
  cql?: string;
  space?: string;
  title?: string;
  text?: string;
  label?: string;
  type?: string;
}): string | null {
  if (args.cql?.trim()) {
    return args.cql.trim();
  }
  const parts: string[] = [];
  if (args.space?.trim()) parts.push(`space = "${cqlQuote(args.space.trim())}"`);
  if (args.title?.trim()) parts.push(`title ~ "${cqlQuote(args.title.trim())}"`);
  if (args.text?.trim()) parts.push(`text ~ "${cqlQuote(args.text.trim())}"`);
  if (args.label?.trim()) parts.push(`label = "${cqlQuote(args.label.trim())}"`);
  parts.push(`type = "${cqlQuote(args.type?.trim() || "page")}"`);
  return parts.length > 1 ? parts.join(" AND ") : null;
}

function isCloud(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes(".atlassian.net");
}

function webBase(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/g, "");
  if (!trimmed) return "";
  if (isCloud(trimmed)) {
    const withoutWiki = trimmed.endsWith("/wiki") ? trimmed.slice(0, -5) : trimmed;
    return `${withoutWiki}/wiki`;
  }
  return trimmed;
}

function apiBase(rawUrl: string): string {
  return `${webBase(rawUrl)}/rest/api`;
}

function normalizeBaseUrl(rawUrl: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)
    ? rawUrl
    : `https://${rawUrl}`;
  const base = webBase(withScheme);
  try {
    // Validate early so a malformed env var returns a tool error, not an
    // unhandled exception before the fetch try/catch.
    new URL(base);
    return withScheme;
  } catch {
    return null;
  }
}

function webUrl(baseUrl: string, links: JsonRecord): string | null {
  const webui = asString(links.webui);
  return webui ? `${webBase(baseUrl)}${webui}` : null;
}

function credentials(ctx: ConfluenceToolsContext):
  | { ok: true; baseUrl: string; apiBase: string; pat: string }
  | { ok: false; message: string } {
  const baseUrl = ctx.config.confluenceUrl?.trim();
  if (!baseUrl) {
    return { ok: false, message: "The CONFLUENCE_URL environment variable is not set." };
  }
  const normalizedUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedUrl) {
    return { ok: false, message: "The CONFLUENCE_URL format is invalid." };
  }
  const pat =
    ctx.ownerSecrets[CONFLUENCE_PAT_SECRET_NAME]?.trim() ||
    ctx.ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN?.trim();
  if (!pat) {
    return {
      ok: false,
      message: "The CONFLUENCE_PAT secret is not set. Register CONFLUENCE_PAT under Settings > Permissions & Connections > Secrets.",
    };
  }
  return { ok: true, baseUrl: normalizedUrl, apiBase: apiBase(normalizedUrl), pat };
}

async function requestJson(
  ctx: ConfluenceToolsContext,
  path: string,
  options: {
    method?: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  } = {},
): Promise<{ ok: true; baseUrl: string; data: JsonRecord } | { ok: false; message: string }> {
  const creds = credentials(ctx);
  if (!creds.ok) return creds;

  const url = new URL(`${creds.apiBase}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${creds.pat}`,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: controller.signal,
    });
    const raw = await res.text();
    let data: JsonRecord = {};
    if (raw) {
      try {
        data = asRecord(JSON.parse(raw));
      } catch {
        data = { raw };
      }
    }
    if (!res.ok) {
      const detail = raw ? `: ${truncate(raw.replace(/\s+/g, " "), 500)}` : "";
      return { ok: false, message: `Confluence HTTP ${res.status}${detail}` };
    }
    return { ok: true, baseUrl: creds.baseUrl, data };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Confluence request failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function formatPageSummary(baseUrl: string, page: JsonRecord): JsonRecord {
  const space = asRecord(page.space);
  const version = asRecord(page.version);
  return {
    id: asString(page.id),
    title: asString(page.title),
    type: asString(page.type),
    spaceKey: asString(space.key),
    version: asNumber(version.number),
    url: webUrl(baseUrl, asRecord(page._links)),
  };
}

function pageBody(page: JsonRecord): string {
  const body = asRecord(page.body);
  const storage = asRecord(body.storage);
  return asString(storage.value);
}

export function buildConfluenceTools(ctx: ConfluenceToolsContext) {
  return [
    tool(
      "describe_config",
      "Check the configuration status of the shared Confluence tools. Does not return the URL/PAT values themselves.",
      {},
      async () => {
        const baseUrl = ctx.config.confluenceUrl?.trim();
        const hasPat = Boolean(
          ctx.ownerSecrets[CONFLUENCE_PAT_SECRET_NAME]?.trim() ||
            ctx.ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN?.trim(),
        );
        const lines = [
          "Confluence tool configuration:",
          `- host: ${baseUrl ? "configured" : "not set"}`,
          `- PAT secret: ${hasPat ? "configured" : "not set"}`,
          "- auth: on-prem Personal Access Token (Bearer)",
        ];
        return text(lines.join("\n"));
      },
    ),
    tool(
      "list_spaces",
      "Fetch the list of Confluence spaces.",
      {
        limit: z.number().int().min(1).max(100).optional().describe("Number of results to fetch, default 25"),
        start: z.number().int().min(0).optional().describe("Pagination start offset, default 0"),
      },
      async (args) => {
        const res = await requestJson(ctx, "/space", {
          query: { limit: args.limit ?? 25, start: args.start ?? 0 },
        });
        if (!res.ok) return text(res.message, true);
        const results = Array.isArray(res.data.results) ? res.data.results.map(asRecord) : [];
        if (!results.length) {
          return text("No Confluence spaces found.");
        }
        return text(JSON.stringify(results.map((s) => ({
          key: asString(s.key),
          name: asString(s.name),
          type: asString(s.type),
        })), null, 2));
      },
    ),
    tool(
      "search",
      "Search Confluence pages with CQL. Provide cql directly, or combine space/title/text/label conditions.",
      {
        cql: z.string().optional().describe("Raw CQL. If present, takes precedence over the other search conditions."),
        space: z.string().optional().describe("space key"),
        title: z.string().optional().describe("Fuzzy search on title"),
        text: z.string().optional().describe("Fuzzy search on body"),
        label: z.string().optional().describe("Exact label match"),
        type: z.string().optional().describe("content type, default page"),
        limit: z.number().int().min(1).max(100).optional().describe("Number of results to fetch, default 25"),
        start: z.number().int().min(0).optional().describe("Pagination start offset, default 0"),
      },
      async (args) => {
        const cql = buildCql(args);
        if (!cql) {
          return text("Provide cql or at least one of space/title/text/label.", true);
        }
        const res = await requestJson(ctx, "/content/search", {
          query: {
            cql,
            limit: args.limit ?? 25,
            start: args.start ?? 0,
            expand: "space,version",
          },
        });
        if (!res.ok) return text(res.message, true);
        const results = Array.isArray(res.data.results) ? res.data.results.map(asRecord) : [];
        const summary = {
          cql,
          size: asNumber(res.data.size) ?? results.length,
          results: results.map((page) => formatPageSummary(res.baseUrl, page)),
        };
        return text(JSON.stringify(summary, null, 2));
      },
    ),
    tool(
      "get_page",
      "Fetch a Confluence page by ID. By default returns metadata + storage body.",
      {
        page_id: z.string().describe("Confluence page id"),
        max_body_chars: z.number().int().min(0).max(100_000).optional().describe("Maximum number of body characters, default 20000"),
      },
      async (args) => {
        const res = await requestJson(ctx, `/content/${encodeURIComponent(args.page_id)}`, {
          query: { expand: "body.storage,version,space,ancestors,metadata.labels" },
        });
        if (!res.ok) return text(res.message, true);
        const body = pageBody(res.data);
        const max = args.max_body_chars ?? MAX_BODY_CHARS;
        const labels = asRecord(asRecord(res.data.metadata).labels);
        const labelResults = Array.isArray(labels.results) ? labels.results.map(asRecord) : [];
        const ancestors = Array.isArray(res.data.ancestors) ? res.data.ancestors.map(asRecord) : [];
        const payload = {
          ...formatPageSummary(res.baseUrl, res.data),
          labels: labelResults.map((l) => asString(l.name)).filter(Boolean),
          ancestors: ancestors.map((a) => ({ id: asString(a.id), title: asString(a.title) })),
          body_storage: max === 0 ? undefined : truncate(body, max),
        };
        return text(JSON.stringify(payload, null, 2));
      },
    ),
    tool(
      "create_page",
      "Create a Confluence page. body_storage must be in Confluence storage XHTML format. (owner/trusted only)",
      {
        space_key: z.string().describe("space key to create the page in"),
        title: z.string().describe("Page title"),
        body_storage: z.string().describe("Confluence storage XHTML body"),
        parent_id: z.string().optional().describe("Parent page id"),
      },
      async (args) => {
        if (!ctx.elevated) return text(WRITE_DENIED, true);
        const body: JsonRecord = {
          type: "page",
          title: args.title,
          space: { key: args.space_key },
          body: { storage: { value: args.body_storage, representation: "storage" } },
        };
        if (args.parent_id?.trim()) {
          body.ancestors = [{ id: args.parent_id.trim() }];
        }
        const res = await requestJson(ctx, "/content", { method: "POST", body });
        if (!res.ok) return text(res.message, true);
        return text(JSON.stringify(formatPageSummary(res.baseUrl, res.data), null, 2));
      },
    ),
    tool(
      "update_page",
      "Update a Confluence page body/title. Fetches the current version, then PUTs with version +1. (owner/trusted only)",
      {
        page_id: z.string().describe("page id to update"),
        body_storage: z.string().describe("New Confluence storage XHTML body"),
        title: z.string().optional().describe("New title. If omitted, keeps the existing title"),
        version_message: z.string().optional().describe("Version comment"),
        minor_edit: z.boolean().optional().describe("Whether this is a minor edit, default false"),
      },
      async (args) => {
        if (!ctx.elevated) return text(WRITE_DENIED, true);
        const current = await requestJson(ctx, `/content/${encodeURIComponent(args.page_id)}`, {
          query: { expand: "version,space" },
        });
        if (!current.ok) return text(current.message, true);
        const version = asNumber(asRecord(current.data.version).number);
        if (!version) {
          return text("Could not determine the current page version.", true);
        }
        const payload: JsonRecord = {
          id: args.page_id,
          type: "page",
          title: args.title?.trim() || asString(current.data.title),
          version: {
            number: version + 1,
            minorEdit: args.minor_edit ?? false,
          },
          body: { storage: { value: args.body_storage, representation: "storage" } },
        };
        if (args.version_message?.trim()) {
          (payload.version as JsonRecord).message = args.version_message.trim();
        }
        const res = await requestJson(ctx, `/content/${encodeURIComponent(args.page_id)}`, {
          method: "PUT",
          body: payload,
        });
        if (!res.ok) return text(res.message, true);
        return text(JSON.stringify(formatPageSummary(res.baseUrl, res.data), null, 2));
      },
    ),
  ];
}

export function buildConfluenceServer(ctx: ConfluenceToolsContext) {
  return createSdkMcpServer({
    name: CONFLUENCE_SERVER_NAME,
    version: "0.1.0",
    tools: buildConfluenceTools(ctx),
  });
}
