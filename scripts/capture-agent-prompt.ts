// Capture what the avatar actually sends to the Anthropic API: the resolved
// `system` (preset + append) and the advertised `tools` array. See
// docs/PROMPT-ANATOMY.md for the why and the measured numbers.
//
// How: point ANTHROPIC_BASE_URL at a local HTTP server, run ONE turn with a dummy
// key, return HTTP 529 so the CLI stops fast, and read the outgoing request body.
// No real API call leaves the machine.
//
//   npx tsx scripts/capture-agent-prompt.ts real     # full app path (default)
//   npx tsx scripts/capture-agent-prompt.ts preset   # bare preset + append (no MCP tools)
//
// `real`  builds a real Store + AppConfig and calls runClaudeAgent (true option
//          assembly: mcpServers, allowedTools, disallowedTools).
// `preset` runs a bare query() with just the preset + a fixed append — for diffing
//          the preset/append split without the MCP plumbing.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Marker from buildSystemPromptAppend used to pick the MAIN turn over the SDK's
// session-title side request (which uses a different, tiny system prompt).
const MAIN_TURN_MARKER = "Noah Almighty (avatar-chat)";
const SDK_PATH = new URL("../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", import.meta.url).href;

function startCaptureServer(onMain: (body: any) => void) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.includes("/v1/messages") && body) {
        try {
          const json = JSON.parse(body);
          const sys = Array.isArray(json.system)
            ? json.system.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("\n")
            : String(json.system ?? "");
          if (json.tools && sys.includes(MAIN_TURN_MARKER)) onMain(json);
        } catch {}
      }
      res.writeHead(529, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "stop" } }));
    });
  });
  return server;
}

function reportAndWrite(outDir: string, req: any) {
  const sys = Array.isArray(req.system)
    ? req.system.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("\n")
    : String(req.system ?? "");
  fs.writeFileSync(path.join(outDir, "system.txt"), sys, "utf8");
  fs.writeFileSync(path.join(outDir, "request.json"), JSON.stringify(req, null, 2), "utf8");
  const tools = req.tools ?? [];
  const total = tools.reduce((s: number, t: any) => s + (t.description || "").length, 0);
  const mcp = tools.filter((t: any) => String(t.name).startsWith("mcp__")).map((t: any) => t.name);
  const sizes = tools
    .map((t: any) => ({ name: t.name, n: (t.description || "").length }))
    .sort((a: any, b: any) => b.n - a.n);
  console.log(`system: ${sys.length} chars (~${Math.round(sys.length / 4)} tokens)`);
  console.log(`tools: ${tools.length} (mcp__: ${mcp.length})`);
  console.log(`tool descriptions total: ${total} chars (~${Math.round(total / 4)} tokens)`);
  console.log("top 10 tools by description size:");
  for (const s of sizes.slice(0, 10)) console.log(`  ${String(s.n).padStart(6)}  ${s.name}`);
  console.log(`\nwrote: ${path.join(outDir, "system.txt")}\n       ${path.join(outDir, "request.json")}`);
}

async function waitFor(get: () => boolean, ms = 120_000) {
  const end = Date.now() + ms;
  while (!get() && Date.now() < end) await new Promise((r) => setTimeout(r, 300));
}

async function captureReal(outDir: string) {
  let captured: any = null;
  const server = startCaptureServer((b) => { if (!captured) captured = b; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.ANTHROPIC_API_KEY = "sk-ant-dummy-capture";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

  const { loadConfig } = await import(new URL("../src/server/config.ts", import.meta.url).href);
  const { Store } = await import(new URL("../src/server/store.ts", import.meta.url).href);
  const { runClaudeAgent } = await import(new URL("../src/server/agent/claudeAgent.ts", import.meta.url).href);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-capture-"));
  const config: any = loadConfig({ dataDir, sessionSecret: "dev", anthropicApiKey: "sk-ant-dummy-capture" });
  const store: any = new Store(config);
  const user = store.createUser({ username: "owner", displayName: "도우미", password: "password123" });

  const request: any = {
    message: "안녕, 시스템 상태 알려줘",
    conversationId: "c1",
    avatar: { id: user.id, displayName: "도우미", alias: "세바스찬", persona: "친절하게" },
    viewerUserId: user.id,
    viewerName: "지영",
    viewerIsOwner: true,
    elevated: true,
    mcpToolGroups: ["personal_knowledge", "group_knowledge", "git_repo", "confluence", "ssh", "avatars", "canvas", "system"],
  };
  const ac = new AbortController();
  const run = runClaudeAgent(request, [], config, store, undefined, ac).catch(() => {});
  await waitFor(() => Boolean(captured));
  ac.abort();
  await Promise.race([run, new Promise((r) => setTimeout(r, 2000))]);
  server.close();
  if (!captured) throw new Error("no capture (real path)");
  reportAndWrite(outDir, captured);
}

async function capturePreset(outDir: string) {
  // Bare query() with preset + a fixed append (no MCP servers). The append must
  // contain MAIN_TURN_MARKER so the capture filter accepts it.
  let captured: any = null;
  const server = startCaptureServer((b) => { if (!captured) captured = b; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.ANTHROPIC_API_KEY = "sk-ant-dummy-capture";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

  const { query } = (await import(SDK_PATH)) as any;
  const append = `System meta-cognition: this service is ${MAIN_TURN_MARKER}. (capture-script fixed append)`;
  const q = query({
    prompt: "안녕",
    options: {
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code", append, excludeDynamicSections: true },
      settingSources: [],
      maxTurns: 1,
      env: { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "sk-ant-dummy-capture" },
    },
  });
  (async () => { try { for await (const _ of q) { if (captured) break; } } catch {} })();
  await waitFor(() => Boolean(captured));
  server.close();
  if (!captured) throw new Error("no capture (preset path)");
  reportAndWrite(outDir, captured);
}

async function main() {
  const mode = (process.argv[2] || "real").toLowerCase();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-capture-"));
  console.log(`mode: ${mode}\noutput dir: ${outDir}\n`);
  if (mode === "preset") await capturePreset(outDir);
  else await captureReal(outDir);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
