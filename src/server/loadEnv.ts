import fs from "node:fs";
import path from "node:path";

/**
 * Load a `.env` file from the working directory into `process.env`, so the app
 * can be configured via a file (as the README and `.env.example` assume) WITHOUT
 * a dotenv dependency or a `node --env-file` flag — the flag isn't forwarded by
 * `tsx` (dev) and is disallowed inside `NODE_OPTIONS`, so it wouldn't work
 * uniformly across dev (`tsx watch`) and prod (`node dist`). Uses Node's built-in
 * `process.loadEnvFile` (Node 20.12+/22).
 *
 * Precedence (verified on Node 22): a variable already present in the REAL
 * environment (Docker `-e`, compose `environment`, shell `export`) WINS — the
 * file only fills in keys that aren't already set. Best-effort: a missing file is
 * a silent no-op; a malformed one is logged to stderr, not fatal. `ENV_FILE`
 * overrides the path.
 */
export function loadDotEnv(
  file = path.resolve(process.cwd(), process.env.ENV_FILE || ".env"),
): boolean {
  if (typeof process.loadEnvFile !== "function" || !fs.existsSync(file)) {
    return false;
  }
  try {
    process.loadEnvFile(file);
    return true;
  } catch (error) {
    process.stderr.write(
      `[loadEnv] could not load ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}

// Auto-load at import time for the real entrypoint, BEFORE any other module reads
// process.env at evaluation (e.g. auth's SECURE_COOKIES, logger's LOG_LEVEL).
// `index.ts` imports this FIRST. Skipped under test so suites rely on explicit
// config (createServices overrides) instead of a developer's stray local .env.
if (process.env.NODE_ENV !== "test") {
  loadDotEnv();
}
