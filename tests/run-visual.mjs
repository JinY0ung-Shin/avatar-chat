import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "vite";

// Playwright's built-in readiness probe can wait on a filtered localhost port
// in WSL before it launches its webServer. Starting Vite directly makes this
// runner deterministic locally and in CI, while still guaranteeing cleanup.
const server = await createServer({
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});

try {
  await server.listen();
  const cli = resolve("node_modules/@playwright/test/cli.js");
  const child = spawn(process.execPath, [cli, "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = Number(exitCode);
} finally {
  await server.close();
}
