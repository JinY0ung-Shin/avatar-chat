// Coverage-gap tests for the in-process MCP tool servers under src/server/agent/.
// Companion to agent-tools.test.ts: this file targets branches that file leaves
// uncovered (Confluence request/attachment plumbing, brain/group-brain happy
// paths over a real local clone, group-repo list/scaffold/commit/create_repo,
// ssh-trust add/remove, and the shared mcpTools helpers). Everything is offline:
// fetch is stubbed per test, git uses local bare remotes, addTrustedHost is
// mocked (its real impl needs a live SSH handshake). No real SDK is exercised.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createServices } from "../src/server/app.js";
import {
  buildConfluenceTools,
  buildConfluenceServer,
  CONFLUENCE_SERVER_NAME,
} from "../src/server/agent/confluenceTools.js";
import {
  buildBrainTools,
  buildBrainServer,
  BRAIN_SERVER_NAME,
} from "../src/server/agent/brainTools.js";
import {
  buildGroupBrainTools,
  buildGroupBrainServer,
  GROUP_BRAIN_SERVER_NAME,
} from "../src/server/agent/groupBrainTools.js";
import {
  buildGroupRepoTools,
  buildGroupRepoServer,
  GROUP_REPO_SERVER_NAME,
} from "../src/server/agent/groupRepoTools.js";
import {
  buildSshTrustTools,
  buildSshTrustServer,
  SSH_TRUST_SERVER_NAME,
} from "../src/server/agent/sshTrustTools.js";
import { text, decodeRepoFsError, decodeExecError } from "../src/server/agent/mcpTools.js";
import type { AppConfig } from "../src/server/types.js";
import { gitInit, makeBareRemote, callTool } from "./helpers.js";

// addTrustedHost fetches a live host key over an SSH handshake (paramiko); mock
// it so the add_host success path is deterministic + offline. listTrustedHosts /
// removeTrustedHost stay REAL (file-backed) via importActual.
vi.mock("../src/server/sshTrust.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/server/sshTrust.js")>();
  return { ...actual, addTrustedHost: vi.fn() };
});
import { addTrustedHost } from "../src/server/sshTrust.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-gaps-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// confluenceTools — the request/attachment plumbing agent-tools.test.ts skips
// ---------------------------------------------------------------------------

describe("confluence tools — request + attachment plumbing", () => {
  function makeConfig(confluenceUrl?: string): AppConfig {
    return createServices({
      dataDir: path.join(tempDir, `conf-${Math.random().toString(36).slice(2)}`),
      agentRuntime: "local",
      sessionSecret: "t",
      confluenceUrl,
    }).config;
  }

  /** Elevated Confluence ctx pointed at `url` (default on-prem) with a PAT. */
  function ctx(url = "https://confluence.internal/confluence", elevated = true) {
    return { config: makeConfig(url), ownerSecrets: { CONFLUENCE_PAT: "pat" }, elevated };
  }

  /** Stub global fetch with a URL-dispatching handler. Throwing inside rejects. */
  function stubFetch(impl: (url: URL, init: RequestInit) => unknown) {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(impl(new URL(String(input)), init ?? {})),
    );
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  /** A minimal Response-shaped object so content-length/body can be controlled exactly. */
  function fakeBinary(opts: {
    ok?: boolean;
    status?: number;
    contentLength?: string | null;
    contentType?: string | null;
    bytes?: Uint8Array;
    errorText?: string;
  }): Response {
    const { ok = true, status = 200, contentLength = null, contentType = null, bytes, errorText = "" } = opts;
    return {
      ok,
      status,
      headers: {
        get(header: string) {
          const h = header.toLowerCase();
          if (h === "content-length") return contentLength;
          if (h === "content-type") return contentType;
          return null;
        },
      },
      async text() {
        return errorText;
      },
      async arrayBuffer() {
        const b = bytes ?? new Uint8Array();
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    } as unknown as Response;
  }

  it("describe_config reports host/PAT status when elevated, and refuses otherwise", async () => {
    const configured = await callTool(buildConfluenceTools(ctx()), "describe_config", {});
    expect(configured.isError).toBeFalsy();
    expect(configured.content[0].text).toContain("host: configured");
    expect(configured.content[0].text).toContain("PAT secret: configured");

    // No URL, no PAT → both report "not set" (still no secret leakage).
    const bare = await callTool(
      buildConfluenceTools({ config: makeConfig(), ownerSecrets: {}, elevated: true }),
      "describe_config",
      {},
    );
    expect(bare.content[0].text).toContain("host: not set");
    expect(bare.content[0].text).toContain("PAT secret: not set");

    const denied = await callTool(
      buildConfluenceTools({ ...ctx(), elevated: false }),
      "describe_config",
      {},
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("owner or trusted user");
  });

  it("list_spaces returns space rows, and reports the empty case", async () => {
    stubFetch(() => json({ results: [{ key: "DEV", name: "Development", type: "global" }] }));
    const listed = await callTool(buildConfluenceTools(ctx()), "list_spaces", { limit: 10, start: 0 });
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0].text).toContain("DEV");
    expect(listed.content[0].text).toContain("Development");

    stubFetch(() => json({ results: [] }));
    const empty = await callTool(buildConfluenceTools(ctx()), "list_spaces", {});
    expect(empty.content[0].text).toContain("No Confluence spaces found");

    const denied = await callTool(buildConfluenceTools({ ...ctx(), elevated: false }), "list_spaces", {});
    expect(denied.isError).toBe(true);
  });

  it("search rejects an empty query, accepts raw CQL, and reaches the cloud /wiki API base", async () => {
    // No cql / space / title / text / label → buildCql yields only `type=page` → refused.
    const noCriteria = await callTool(buildConfluenceTools(ctx()), "search", {});
    expect(noCriteria.isError).toBe(true);
    expect(noCriteria.content[0].text).toContain("Provide cql or at least one");

    // Raw cql takes precedence and is sent verbatim.
    let seenCql: string | null = null;
    stubFetch((url) => {
      seenCql = url.searchParams.get("cql");
      return json({ size: 0, results: [] });
    });
    const raw = await callTool(buildConfluenceTools(ctx()), "search", { cql: "label = \"runbook\"" });
    expect(raw.isError).toBeFalsy();
    expect(seenCql).toBe('label = "runbook"');

    // Atlassian Cloud base → the REST path is prefixed with /wiki.
    let cloudPath: string | null = null;
    stubFetch((url) => {
      cloudPath = url.pathname;
      return json({ size: 0, results: [] });
    });
    const cloud = await callTool(
      buildConfluenceTools({ config: makeConfig("https://acme.atlassian.net"), ownerSecrets: { CONFLUENCE_PAT: "pat" }, elevated: true }),
      "search",
      { text: "auth" },
    );
    expect(cloud.isError).toBeFalsy();
    expect(cloudPath).toBe("/wiki/rest/api/content/search");
  });

  it("search surfaces an HTTP error (truncated body) and a network failure", async () => {
    // Non-2xx with a long non-JSON body → JSON.parse fallback + truncated detail.
    stubFetch(() => new Response("x".repeat(1200), { status: 502 }));
    const httpErr = await callTool(buildConfluenceTools(ctx()), "search", { text: "auth" });
    expect(httpErr.isError).toBe(true);
    expect(httpErr.content[0].text).toContain("Confluence HTTP 502");
    expect(httpErr.content[0].text).toContain("[truncated");

    // fetch itself rejects → the request-failed catch.
    stubFetch(() => {
      throw new Error("ECONNRESET");
    });
    const netErr = await callTool(buildConfluenceTools(ctx()), "search", { text: "auth" });
    expect(netErr.isError).toBe(true);
    expect(netErr.content[0].text).toContain("Confluence request failed");
    expect(netErr.content[0].text).toContain("ECONNRESET");
  });

  it("reports an invalid CONFLUENCE_URL as a tool error, not an exception", async () => {
    const res = await callTool(
      buildConfluenceTools({ config: makeConfig("http://"), ownerSecrets: { CONFLUENCE_PAT: "pat" }, elevated: true }),
      "search",
      { text: "auth" },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("CONFLUENCE_URL format is invalid");
  });

  it("get_page returns metadata, labels, ancestors and a truncated body", async () => {
    stubFetch(() =>
      json({
        id: "42",
        type: "page",
        title: "Runbook",
        space: { key: "DEV" },
        version: { number: 3 },
        _links: { webui: "/pages/42" },
        ancestors: [{ id: "1", title: "Root" }],
        metadata: { labels: { results: [{ name: "ops" }, { name: "oncall" }] } },
        body: { storage: { value: "A".repeat(50) } },
      }),
    );
    const res = await callTool(buildConfluenceTools(ctx()), "get_page", { page_id: "42", max_body_chars: 10 });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text ?? "{}");
    expect(payload.title).toBe("Runbook");
    expect(payload.labels).toEqual(["ops", "oncall"]);
    expect(payload.ancestors).toEqual([{ id: "1", title: "Root" }]);
    expect(payload.body_storage).toContain("[truncated");
  });

  it("get_attachment: needs an argument, and errors when metadata lacks a download URL", async () => {
    // Neither attachment_id nor page_id+filename.
    const noArgs = await callTool(buildConfluenceTools(ctx()), "get_attachment", {});
    expect(noArgs.isError).toBe(true);
    expect(noArgs.content[0].text).toContain("Provide attachment_id, or provide page_id with filename");

    // Metadata present but carries no download link.
    stubFetch(() => json({ id: "att-1", type: "attachment", title: "x.bin", metadata: {}, _links: {} }));
    const noUrl = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-1" });
    expect(noUrl.isError).toBe(true);
    expect(noUrl.content[0].text).toContain("did not include a download URL");
  });

  it("get_attachment resolves by page_id+filename and returns a text attachment inline", async () => {
    stubFetch((url) => {
      if (url.pathname.includes("/child/attachment")) {
        return json({
          results: [
            {
              id: "att-9",
              type: "attachment",
              title: "notes.txt",
              metadata: {},
              extensions: { fileSize: 5 },
              _links: { download: "/download/attachments/7/notes.txt" },
            },
          ],
        });
      }
      // The binary download: octet-stream content-type forces media-type-from-filename.
      return fakeBinary({ contentType: "application/octet-stream", bytes: new TextEncoder().encode("hello") });
    });
    const res = await callTool(buildConfluenceTools(ctx()), "get_attachment", { page_id: "7", filename: "notes.txt" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text ?? "{}");
    expect(payload.download.returnedAs).toBe("text");
    expect(payload.text).toBe("hello");
  });

  it("get_attachment reports a filename not present on the page", async () => {
    stubFetch(() => json({ results: [{ id: "att-9", type: "attachment", title: "other.txt", _links: {} }] }));
    const res = await callTool(buildConfluenceTools(ctx()), "get_attachment", { page_id: "7", filename: "missing.txt" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('No Confluence attachment named "missing.txt"');
  });

  it("get_attachment notes an unsupported (non-image, non-text) media type instead of inlining it", async () => {
    stubFetch((url) => {
      if (url.pathname.endsWith("/content/att-z")) {
        return json({
          id: "att-z",
          type: "attachment",
          title: "archive.zip",
          metadata: { mediaType: "application/zip" },
          _links: { download: "/download/attachments/7/archive.zip" },
        });
      }
      return fakeBinary({ contentType: "application/zip", bytes: new Uint8Array([1, 2, 3]) });
    });
    const res = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-z" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text ?? "{}");
    expect(payload.note).toContain("not returned inline");
  });

  it("get_attachment enforces size limits from content-length, HTTP status, and post-download length", async () => {
    // content-length already exceeds max_bytes → rejected before reading the body.
    stubFetch((url) => {
      if (url.pathname.endsWith("/content/att-big")) {
        return json({ id: "att-big", title: "big.png", metadata: { mediaType: "image/png" }, _links: { download: "/download/x/big.png" } });
      }
      return fakeBinary({ contentLength: "9999999", contentType: "image/png" });
    });
    const tooLargeHeader = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-big", max_bytes: 8 });
    expect(tooLargeHeader.isError).toBe(true);
    expect(tooLargeHeader.content[0].text).toContain("too large");

    // Download returns a non-2xx status.
    stubFetch((url) => {
      if (url.pathname.endsWith("/content/att-403")) {
        return json({ id: "att-403", title: "denied.png", metadata: { mediaType: "image/png" }, _links: { download: "/download/x/denied.png" } });
      }
      return fakeBinary({ ok: false, status: 403, errorText: "forbidden" });
    });
    const forbidden = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-403" });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content[0].text).toContain("Confluence HTTP 403");

    // No content-length header, but the body itself exceeds max_bytes.
    stubFetch((url) => {
      if (url.pathname.endsWith("/content/att-stream")) {
        return json({ id: "att-stream", title: "s.png", metadata: { mediaType: "image/png" }, _links: { download: "/download/x/s.png" } });
      }
      return fakeBinary({ contentType: "image/png", bytes: new Uint8Array(64) });
    });
    const oversizeBody = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-stream", max_bytes: 10 });
    expect(oversizeBody.isError).toBe(true);
    expect(oversizeBody.content[0].text).toContain("too large");
  });

  it("extract_page_assets can download referenced images and records a failed download", async () => {
    stubFetch((url) => {
      if (url.pathname.includes("/child/attachment")) {
        return json({
          results: [
            {
              id: "img-ok",
              type: "attachment",
              title: "diagram.png",
              metadata: { mediaType: "image/png" },
              _links: { download: "/download/attachments/p/diagram.png" },
            },
            {
              id: "img-bad",
              type: "attachment",
              title: "broken.png",
              metadata: { mediaType: "image/png" },
              _links: { download: "/download/attachments/p/broken.png" },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/diagram.png")) {
        return fakeBinary({ contentType: "image/png", bytes: new Uint8Array([9, 9, 9]) });
      }
      if (url.pathname.endsWith("/broken.png")) {
        return fakeBinary({ ok: false, status: 500, errorText: "boom" });
      }
      // The page body: image refs (with HTML numeric entities) + a drawio macro
      // whose parameter name is a bare "file" so the candidate branch is exercised.
      return json({
        id: "p",
        type: "page",
        title: "Arch",
        space: { key: "DEV" },
        version: { number: 1 },
        _links: { webui: "/pages/p" },
        body: {
          storage: {
            value:
              '<ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>' +
              '<ac:image><ri:attachment ri:filename="broke&#x6e;.png" /></ac:image>' +
              '<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="file">flow.drawio</ac:parameter></ac:structured-macro>',
          },
        },
      });
    });
    const res = await callTool(buildConfluenceTools(ctx()), "extract_page_assets", {
      page_id: "p",
      include_images: true,
      max_images: 5,
    });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text ?? "{}");
    // Numeric entity decoded: broke&#x6e;.png → broken.png.
    expect(payload.references.imageFilenames).toContain("broken.png");
    expect(payload.references.drawioMacros[0].candidateFilenames).toContain("flow.drawio");
    // One image downloaded OK (an image block returned), one recorded as an error.
    const errored = payload.inlineImages.find((i: { error?: string }) => i.error);
    expect(errored).toBeTruthy();
    expect(res.content.some((c) => c.type === "image")).toBe(true);
  });

  it("never sends anything but GET to Confluence", async () => {
    // The write TOOLS are gone; this pins the layer underneath them, since the
    // PAT in play is the owner's and carries their full write access.
    const methods: (string | undefined)[] = [];
    stubFetch((url, init) => {
      methods.push(init.method);
      return json({ id: "1", type: "page", title: "T", version: { number: 1 }, results: [] });
    });
    const tools = buildConfluenceTools(ctx());
    const argsByTool: Record<string, Record<string, unknown>> = {
      list_spaces: {},
      search: { text: "auth" },
      get_page: { page_id: "1" },
      list_attachments: { page_id: "1" },
      extract_page_assets: { page_id: "1" },
    };
    for (const [name, args] of Object.entries(argsByTool)) {
      await callTool(tools, name, args);
    }
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((method) => method === undefined || method === "GET")).toBe(true);
  });

  it("buildConfluenceServer exposes the named MCP server", () => {
    const server = buildConfluenceServer(ctx());
    expect(server).toBeTruthy();
    expect(CONFLUENCE_SERVER_NAME).toBe("confluence");
  });
});

// ---------------------------------------------------------------------------
// brainTools — personal second-brain search over a REAL local clone
// ---------------------------------------------------------------------------

/** Seed a bare remote from `files` (repo-relative path → content) on `main`. */
function seedRemote(dir: string, files: Record<string, string>): string {
  const remote = makeBareRemote(path.join(dir, "remote.git"));
  const seed = path.join(dir, "seed");
  gitInit(seed);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(seed, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return remote;
}

describe("brain tools — search + get_note over a real vault", () => {
  function setup(dir: string, files: Record<string, string> | null) {
    const base = path.join(tempDir, dir);
    fs.mkdirSync(base, { recursive: true });
    const { store, config } = createServices({ dataDir: path.join(base, "data"), agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    if (files) {
      const remote = seedRemote(base, files);
      store.setKnowledgeRepo(owner.id, remote, "main");
    }
    return { store, config, owner };
  }
  // Omit `elevated` so the `elevated ?? viewerIsOwner` default path is exercised.
  const tools = (s: ReturnType<typeof setup>) =>
    buildBrainTools(s.store, { avatarUserId: s.owner.id, viewerIsOwner: true, config: s.config });

  const NOTE = "---\ntitle: Deploy Guide\ntags: [ops]\naliases: [rollout]\n---\nUse kubernetes to deploy the service.\n";

  it("ranks a matching wiki note and reads it back with get_note", async () => {
    const s = setup("brain-hit", { "wiki/concepts/deploy.md": NOTE, "README.md": "x" });
    const hit = await callTool(tools(s), "search", { query: "deploy" });
    expect(hit.isError).toBeFalsy();
    expect(hit.content[0].text).toContain("wiki/concepts/deploy.md");
    expect(hit.content[0].text).toContain("Deploy Guide");

    const note = await callTool(tools(s), "get_note", { path: "wiki/concepts/deploy.md" });
    expect(note.isError).toBeFalsy();
    expect(note.content[0].text).toContain("Use kubernetes to deploy");
  });

  it("reports no matches distinctly from an absent vault", async () => {
    const withVault = setup("brain-empty", { "wiki/concepts/deploy.md": NOTE });
    const noMatch = await callTool(tools(withVault), "search", { query: "somethingnobodywrote" });
    expect(noMatch.isError).toBeFalsy();
    expect(noMatch.content[0].text).toContain("No notes in your second brain matched");

    // A repo with neither wiki/ nor raw/ → the migrate-first message.
    const noVault = setup("brain-novault", { "README.md": "just a readme" });
    const res = await callTool(tools(noVault), "search", { query: "deploy" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("brain-migrate");
  });

  it("get_note surfaces a read failure for a missing wiki path", async () => {
    const s = setup("brain-missing", { "wiki/concepts/deploy.md": NOTE });
    const res = await callTool(tools(s), "get_note", { path: "wiki/does-not-exist.md" });
    expect(res.isError).toBe(true);
    // readFile's resolveInRepo guards containment + existence together, so a
    // missing (but wiki-scoped) path decodes to the INVALID_PATH sentinel.
    expect(res.content[0].text).toContain("Invalid path");
  });

  it("maps a clone failure to the load-failure message", async () => {
    const s = setup("brain-clone-fail", null);
    // Point at a bogus local remote so ensureClone throws.
    s.store.setKnowledgeRepo(s.owner.id, path.join(tempDir, "nope.git"), "main");
    const res = await callTool(tools(s), "search", { query: "deploy" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Failed to load the repository");
    expect(res.content[0].text).toContain("no git credentials");
  });

  it("buildBrainServer exposes the named MCP server", () => {
    const s = setup("brain-server", null);
    expect(buildBrainServer(s.store, { avatarUserId: s.owner.id, viewerIsOwner: true, config: s.config })).toBeTruthy();
    expect(BRAIN_SERVER_NAME).toBe("brain");
  });
});

// ---------------------------------------------------------------------------
// groupBrainTools — team second-brain search over a REAL local group clone
// ---------------------------------------------------------------------------

describe("group brain tools — search + get_note over a real group vault", () => {
  function setup(dir: string, files: Record<string, string> | null) {
    const base = path.join(tempDir, dir);
    fs.mkdirSync(base, { recursive: true });
    const { store, config } = createServices({ dataDir: path.join(base, "data"), agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const group = store.createGroup({ name: "Team", createdBy: null });
    store.addGroupMember(group.id, owner.id, "member");
    if (files) {
      const remote = seedRemote(base, files);
      store.setGroupKnowledgeRepo(group.id, remote, "main");
    }
    return { store, config, owner, group };
  }
  const tools = (s: ReturnType<typeof setup>) =>
    buildGroupBrainTools(s.store, { avatarUserId: s.owner.id, viewerIsOwner: true, config: s.config });

  const NOTE = "---\ntitle: Team Runbook\ntags: [oncall]\n---\nEscalate incidents to the platform channel.\n";

  it("ranks a matching group note and reads it with get_note", async () => {
    const s = setup("gb-hit", { "wiki/runbook.md": NOTE });
    const hit = await callTool(tools(s), "search", { group: "Team", query: "incidents" });
    expect(hit.isError).toBeFalsy();
    expect(hit.content[0].text).toContain("Team Runbook");
    expect(hit.content[0].text).toContain("'Team' team brain");

    const note = await callTool(tools(s), "get_note", { group: "Team", path: "wiki/runbook.md" });
    expect(note.isError).toBeFalsy();
    expect(note.content[0].text).toContain("Escalate incidents");
  });

  it("reports no matches, and points a vault-less group repo at brain-migrate", async () => {
    const withVault = setup("gb-empty", { "wiki/runbook.md": NOTE });
    const noMatch = await callTool(tools(withVault), "search", { group: "Team", query: "unrelatedxyz" });
    expect(noMatch.isError).toBeFalsy();
    expect(noMatch.content[0].text).toContain("team brain matched");

    const noVault = setup("gb-novault", { "README.md": "x" });
    const res = await callTool(tools(noVault), "search", { group: "Team", query: "incidents" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("brain-migrate");
  });

  it("get_note surfaces a read failure for a missing group wiki path", async () => {
    const s = setup("gb-missing", { "wiki/runbook.md": NOTE });
    const res = await callTool(tools(s), "get_note", { group: "Team", path: "wiki/ghost.md" });
    expect(res.isError).toBe(true);
    // Same containment+existence guard as the personal server.
    expect(res.content[0].text).toContain("Invalid path");
  });

  it("buildGroupBrainServer exposes the named MCP server", () => {
    const s = setup("gb-server", null);
    expect(buildGroupBrainServer(s.store, { avatarUserId: s.owner.id, viewerIsOwner: true, config: s.config })).toBeTruthy();
    expect(GROUP_BRAIN_SERVER_NAME).toBe("group_brain");
  });
});

// ---------------------------------------------------------------------------
// groupRepoTools — list_groups, scaffold_skill, commit failure, create_repo
// ---------------------------------------------------------------------------

describe("group repo tools — coverage gaps", () => {
  function setup(dir: string, opts: { connectRepo?: boolean; role?: "admin" | "member"; withGroup?: boolean } = {}) {
    const { connectRepo = true, role = "admin", withGroup = true } = opts;
    const base = path.join(tempDir, dir);
    fs.mkdirSync(base, { recursive: true });
    const { store, config } = createServices({ dataDir: path.join(base, "data"), agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    store.setGitToken(owner.id, "tkn");
    let group: { id: string; name: string } | null = null;
    let remote: string | null = null;
    if (withGroup) {
      group = store.createGroup({ name: "Team", createdBy: null });
      store.addGroupMember(group.id, owner.id, role);
      if (connectRepo) {
        remote = seedRemote(base, { "README.md": "# team" });
        store.setGroupKnowledgeRepo(group.id, remote, "main");
      }
    }
    return { store, config, owner: { id: owner.id, username: "owner", displayName: "Owner" }, ownerId: owner.id, group, remote, base };
  }
  const tools = (s: ReturnType<typeof setup>, opts: { createRemoteRepo?: Parameters<typeof buildGroupRepoTools>[2] } = {}) =>
    buildGroupRepoTools(
      s.store,
      { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: true, config: s.config },
      opts.createRemoteRepo ?? {},
    );

  it("list_groups renders the owner's groups, and the no-groups case", async () => {
    const withGroup = setup("gr-list");
    const listed = await callTool(tools(withGroup), "list_groups", {});
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0].text).toContain("1 group(s) I belong to");
    expect(listed.content[0].text).toContain("Team");
    expect(listed.content[0].text).toContain("admin");
    expect(listed.content[0].text).toContain("connected");

    const none = setup("gr-list-none", { withGroup: false });
    const empty = await callTool(tools(none), "list_groups", {});
    expect(empty.content[0].text).toContain("do not belong to any group");
  });

  it("scaffold_skill creates a skill in the group repo for an admin", async () => {
    const s = setup("gr-scaffold");
    const res = await callTool(tools(s), "scaffold_skill", { group: "Team", name: "Team Runbook", description: "escalation steps" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("skills/team-runbook/SKILL.md");
  });

  it("commit surfaces a rebase conflict from an external push", async () => {
    const s = setup("gr-conflict");
    // Establish v1 of a file.
    await callTool(tools(s), "write_file", { group: "Team", path: "notes/x.md", content: "v1" });
    const first = await callTool(tools(s), "commit", { group: "Team", message: "x v1" });
    expect(first.isError).toBeFalsy();

    // A pending local edit to the SAME file…
    await callTool(tools(s), "write_file", { group: "Team", path: "notes/x.md", content: "local edit" });
    // …while an external actor pushes a conflicting change to notes/x.md.
    const ext = path.join(s.base, "ext");
    execFileSync("git", ["clone", "-q", s.remote!, ext], { stdio: "pipe" });
    const g = (...a: string[]) => execFileSync("git", ["-C", ext, ...a], { stdio: "pipe" });
    g("config", "user.email", "e@x.local");
    g("config", "user.name", "Ext");
    fs.writeFileSync(path.join(ext, "notes", "x.md"), "external edit");
    g("add", "-A");
    g("commit", "-q", "-m", "external");
    g("push", "-q", "origin", "main");

    const res = await callTool(tools(s), "commit", { group: "Team", message: "x local" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("CONFLICT");
    expect(res.content[0].text).toContain("notes/x.md");
  });

  it("create_repo refuses when a repo is already connected", async () => {
    const s = setup("gr-create-exists");
    const res = await callTool(tools(s), "create_repo", { group: "Team", name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("already has a shared knowledge repository");
  });

  it("create_repo surfaces a creator failure and leaves the group unconnected", async () => {
    const s = setup("gr-create-fail", { connectRepo: false });
    const create = vi.fn(async () => ({ ok: false as const, exitCode: 1, message: "name already exists" }));
    const res = await callTool(tools(s, { createRemoteRepo: { createRemoteRepo: create } }), "create_repo", {
      group: "Team",
      name: "team-knowledge",
      org: "acme",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Failed to create GitHub repository");
    expect(create).toHaveBeenCalled();
    expect(s.store.listUserGroups(s.ownerId)[0].knowledgeRepoConfigured).toBe(false);
  });

  it("create_repo connects a new repo and seeds its vault", async () => {
    const s = setup("gr-create-ok", { connectRepo: false });
    // The creator returns a local bare remote, so the post-create clone/seed/push runs offline.
    const remote = seedRemote(path.join(s.base, "created"), { "README.md": "seed" });
    const create = vi.fn(async () => ({ ok: true as const, fullName: remote, defaultBranch: "main", isPrivate: true }));
    const res = await callTool(tools(s, { createRemoteRepo: { createRemoteRepo: create } }), "create_repo", {
      group: "Team",
      name: "team-knowledge",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("second-brain vault");
    expect(s.store.listUserGroups(s.ownerId)[0].knowledgeRepoConfigured).toBe(true);
  });

  it("create_repo connects but reports a skipped seed when the clone fails", async () => {
    const s = setup("gr-create-seedfail", { connectRepo: false });
    // A bogus fullName: it connects (store row written) but the seed clone throws.
    const create = vi.fn(async () => ({ ok: true as const, fullName: path.join(tempDir, "ghost.git"), defaultBranch: "main", isPrivate: true }));
    const res = await callTool(tools(s, { createRemoteRepo: { createRemoteRepo: create } }), "create_repo", {
      group: "Team",
      name: "team-knowledge",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Created and connected");
    expect(res.content[0].text).toContain("Skipped initializing the default template");
  });

  it("create_repo reports the outer-catch message when the creator throws", async () => {
    const s = setup("gr-create-throw", { connectRepo: false });
    const create = vi.fn(async () => {
      throw new Error("network exploded");
    });
    const res = await callTool(tools(s, { createRemoteRepo: { createRemoteRepo: create } }), "create_repo", {
      group: "Team",
      name: "team-knowledge",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error while creating GitHub repository");
  });

  it("buildGroupRepoServer exposes the named MCP server", () => {
    const s = setup("gr-server");
    expect(buildGroupRepoServer(s.store, { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: true, config: s.config })).toBeTruthy();
    expect(GROUP_REPO_SERVER_NAME).toBe("group_repo");
  });
});

// ---------------------------------------------------------------------------
// sshTrustTools — add_host success/failure, remove_host miss, server builder
// ---------------------------------------------------------------------------

describe("ssh trust tools — add/remove branches", () => {
  function setup(dir: string) {
    const { store, config } = createServices({ dataDir: path.join(tempDir, dir), agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { config, ownerId: owner.id };
  }

  it("add_host reports a freshly-registered host, and an already-known one", async () => {
    const { config, ownerId } = setup("ssh-add");
    const entry = { host: "10.0.0.5", keyType: "ssh-ed25519", fingerprint: "SHA256:abc" };

    (addTrustedHost as unknown as Mock).mockResolvedValueOnce({ entry, changed: true });
    const added = await callTool(buildSshTrustTools({ avatarUserId: ownerId, config }), "add_host", { host: "10.0.0.5" });
    expect(added.isError).toBeFalsy();
    expect(added.content[0].text).toContain("Registered the host key");
    expect(added.content[0].text).toContain("SHA256:abc");

    (addTrustedHost as unknown as Mock).mockResolvedValueOnce({ entry, changed: false });
    const again = await callTool(buildSshTrustTools({ avatarUserId: ownerId, config }), "add_host", { host: "10.0.0.5", port: 22 });
    expect(again.content[0].text).toContain("already registered");
  });

  it("add_host maps a host-key fetch failure to an actionable network hint", async () => {
    const { config, ownerId } = setup("ssh-add-fail");
    (addTrustedHost as unknown as Mock).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const res = await callTool(buildSshTrustTools({ avatarUserId: ownerId, config }), "add_host", { host: "192.0.2.1", port: 2222 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Could not fetch the host key");
    expect(res.content[0].text).toContain("192.0.2.1:2222");
    expect(res.content[0].text).toContain("reachable from the network");
  });

  it("remove_host reports when the host is not in the trust list", async () => {
    const { config, ownerId } = setup("ssh-remove-miss");
    const res = await callTool(buildSshTrustTools({ avatarUserId: ownerId, config }), "remove_host", { host: "203.0.113.9" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("is not in the trust list");
  });

  it("buildSshTrustServer exposes the named MCP server", () => {
    const { config, ownerId } = setup("ssh-server");
    expect(buildSshTrustServer({ avatarUserId: ownerId, config })).toBeTruthy();
    expect(SSH_TRUST_SERVER_NAME).toBe("ssh_trust");
  });
});

// ---------------------------------------------------------------------------
// mcpTools — the shared result/error helpers, unit-tested directly
// ---------------------------------------------------------------------------

describe("mcpTools shared helpers", () => {
  it("text() wraps a message and marks errors", () => {
    const ok = text("done");
    expect(ok).toEqual({ content: [{ type: "text", text: "done" }], isError: false });
    const err = text("nope", true);
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toBe("nope");
  });

  it("decodeRepoFsError maps each filesystem sentinel and falls back otherwise", () => {
    expect(decodeRepoFsError("INVALID_PATH", { fallback: "fb" })).toBe("Invalid path.");
    expect(decodeRepoFsError("FILE_TOO_LARGE", { fallback: "fb", tooLarge: "too big" })).toBe("too big");
    expect(decodeRepoFsError("NOT_A_FILE", { fallback: "fb", notAFile: "not a file" })).toBe("not a file");
    expect(decodeRepoFsError("SKILL_EXISTS", { fallback: "fb", skillExists: "dup skill" })).toBe("dup skill");
    // Sentinel present but the caller supplied no override → the fallback path.
    expect(decodeRepoFsError("FILE_TOO_LARGE", { fallback: "fb" })).toBe("fb: FILE_TOO_LARGE");
    // Unknown detail → fallback with the raw detail appended.
    expect(decodeRepoFsError("WAT", { fallback: "generic" })).toBe("generic: WAT");
  });

  it("decodeExecError prefers stderr, exposes the exit code, and redacts a token", () => {
    const withStderr = decodeExecError(Object.assign(new Error("m"), { stderr: "boom on stderr", code: 3 }));
    expect(withStderr.message).toContain("boom on stderr");
    expect(withStderr.exitCode).toBe(3);

    // Buffer stdout used when stderr is absent.
    const fromStdout = decodeExecError(Object.assign(new Error("m"), { stdout: Buffer.from("out detail") }));
    expect(fromStdout.message).toContain("out detail");
    expect(fromStdout.exitCode).toBeUndefined();

    // A bare error with a fallback, and token redaction.
    expect(decodeExecError({}, { fallback: "fell back" }).message).toContain("fell back");
    const redacted = decodeExecError(Object.assign(new Error("used ghp_secret here"), { stderr: "ghp_secret leaked" }), {
      redactToken: "ghp_secret",
    });
    expect(redacted.message).not.toContain("ghp_secret");
    expect(redacted.message).toContain("[REDACTED]");
  });
});
