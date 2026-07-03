#!/usr/bin/env node
// Secret-injecting exec wrapper for app-registered MCP stdio servers.
//
// Usage: node mcp-secret-wrapper.mjs --secrets <file.json> -- <command> [args...]
//
// WHY THIS EXISTS: the Agent SDK passes `options.mcpServers` to the CLI as a
// `--mcp-config <json>` command-line ARGUMENT. Anything embedded there —
// including an `env` map — is world-readable via /proc/<pid>/cmdline, and the
// agent's own Bash tool is a child of that CLI process. So secret values must
// never ride in the server definition itself. Instead the app writes them to a
// mode-0600 file and registers `node mcp-secret-wrapper.mjs --secrets <path> --
// <real command…>` as the server: only the PATH appears in argv. This wrapper
// reads the file, deletes it (one-shot handoff), and execs the real server with
// the secrets merged into its environment (secrets win over inherited names).
//
// The child inherits this process's env otherwise (PATH etc. — same as when
// the CLI spawned plugin servers directly), plus whatever non-secret `env` the
// server definition carried (the CLI already applied that to THIS process).
import fs from "node:fs";
import { spawn } from "node:child_process";

function fail(message) {
  process.stderr.write(`[mcp-secret-wrapper] ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const sepIndex = argv.indexOf("--");
if (sepIndex === -1) fail("missing `--` separator before the real command");
const head = argv.slice(0, sepIndex);
const command = argv[sepIndex + 1];
const commandArgs = argv.slice(sepIndex + 2);
if (!command) fail("missing command after `--`");

let secretsFile = null;
for (let i = 0; i < head.length; i += 1) {
  if (head[i] === "--secrets") {
    secretsFile = head[i + 1] ?? null;
    i += 1;
  }
}
if (!secretsFile) fail("missing --secrets <file>");

let secrets = {};
try {
  const raw = fs.readFileSync(secretsFile, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    secrets = parsed;
  }
} catch (error) {
  // A missing file usually means a mid-run server RESPAWN after the one-shot
  // read consumed it. Fail loudly rather than silently starting secret-less.
  fail(`cannot read secrets file (${error?.code ?? error}): ${secretsFile}`);
}
// One-shot: consume the handoff so the plaintext window is as short as
// possible. Best-effort — the run-level stale sweep is the backstop.
try {
  fs.unlinkSync(secretsFile);
} catch {
  /* already gone */
}

const child = spawn(command, commandArgs, {
  stdio: "inherit",
  env: { ...process.env, ...secrets },
});
child.on("error", (error) => fail(`failed to start ${command}: ${error}`));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      /* child already exited */
    }
  });
}
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
