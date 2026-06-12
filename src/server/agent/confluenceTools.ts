import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AppConfig } from "../types.js";

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
const WRITE_DENIED = "Confluence 쓰기 도구는 아바타 소유자 또는 신뢰 사용자 대화에서만 사용할 수 있습니다.";

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

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
    return { ok: false, message: "CONFLUENCE_URL 환경변수가 설정되어 있지 않습니다." };
  }
  const normalizedUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedUrl) {
    return { ok: false, message: "CONFLUENCE_URL 형식이 올바르지 않습니다." };
  }
  const pat =
    ctx.ownerSecrets[CONFLUENCE_PAT_SECRET_NAME]?.trim() ||
    ctx.ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN?.trim();
  if (!pat) {
    return {
      ok: false,
      message: "CONFLUENCE_PAT 시크릿이 설정되어 있지 않습니다. 설정 > 권한·연결 > 시크릿에 CONFLUENCE_PAT을 등록하세요.",
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
    return { ok: false, message: `Confluence 요청 실패: ${msg}` };
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
      "Confluence 공용 도구 설정 상태를 확인한다. URL/PAT 값 자체는 반환하지 않는다.",
      {},
      async () => {
        const baseUrl = ctx.config.confluenceUrl?.trim();
        const hasPat = Boolean(
          ctx.ownerSecrets[CONFLUENCE_PAT_SECRET_NAME]?.trim() ||
            ctx.ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN?.trim(),
        );
        const lines = [
          "Confluence 도구 설정:",
          `- host: ${baseUrl ? "설정됨" : "없음"}`,
          `- PAT secret: ${hasPat ? "설정됨" : "없음"}`,
          "- auth: on-prem Personal Access Token (Bearer)",
        ];
        return text(lines.join("\n"));
      },
    ),
    tool(
      "list_spaces",
      "Confluence space 목록을 조회한다.",
      {
        limit: z.number().int().min(1).max(100).optional().describe("조회 개수, 기본 25"),
        start: z.number().int().min(0).optional().describe("페이지네이션 시작 위치, 기본 0"),
      },
      async (args) => {
        const res = await requestJson(ctx, "/space", {
          query: { limit: args.limit ?? 25, start: args.start ?? 0 },
        });
        if (!res.ok) return text(res.message, true);
        const results = Array.isArray(res.data.results) ? res.data.results.map(asRecord) : [];
        if (!results.length) {
          return text("Confluence space가 없습니다.");
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
      "Confluence CQL로 페이지를 검색한다. cql을 직접 주거나 space/title/text/label 조건을 조합한다.",
      {
        cql: z.string().optional().describe("Raw CQL. 있으면 다른 검색 조건보다 우선한다."),
        space: z.string().optional().describe("space key"),
        title: z.string().optional().describe("제목 fuzzy 검색"),
        text: z.string().optional().describe("본문 fuzzy 검색"),
        label: z.string().optional().describe("label 정확히 일치"),
        type: z.string().optional().describe("content type, 기본 page"),
        limit: z.number().int().min(1).max(100).optional().describe("조회 개수, 기본 25"),
        start: z.number().int().min(0).optional().describe("페이지네이션 시작 위치, 기본 0"),
      },
      async (args) => {
        const cql = buildCql(args);
        if (!cql) {
          return text("cql 또는 space/title/text/label 중 하나 이상을 입력하세요.", true);
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
      "Confluence page를 ID로 조회한다. 기본은 메타데이터+storage body를 반환한다.",
      {
        page_id: z.string().describe("Confluence page id"),
        max_body_chars: z.number().int().min(0).max(100_000).optional().describe("본문 최대 문자 수, 기본 20000"),
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
      "Confluence page를 생성한다. body_storage는 Confluence storage XHTML 형식이어야 한다. (owner/trusted 전용)",
      {
        space_key: z.string().describe("생성할 space key"),
        title: z.string().describe("페이지 제목"),
        body_storage: z.string().describe("Confluence storage XHTML body"),
        parent_id: z.string().optional().describe("부모 page id"),
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
      "Confluence page body/title을 업데이트한다. 현재 version을 조회한 뒤 +1로 PUT한다. (owner/trusted 전용)",
      {
        page_id: z.string().describe("수정할 page id"),
        body_storage: z.string().describe("새 Confluence storage XHTML body"),
        title: z.string().optional().describe("새 제목. 생략하면 기존 제목 유지"),
        version_message: z.string().optional().describe("버전 코멘트"),
        minor_edit: z.boolean().optional().describe("minor edit 여부, 기본 false"),
      },
      async (args) => {
        if (!ctx.elevated) return text(WRITE_DENIED, true);
        const current = await requestJson(ctx, `/content/${encodeURIComponent(args.page_id)}`, {
          query: { expand: "version,space" },
        });
        if (!current.ok) return text(current.message, true);
        const version = asNumber(asRecord(current.data.version).number);
        if (!version) {
          return text("현재 페이지 version을 확인하지 못했습니다.", true);
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
