// MUST be first: loads .env into process.env before any module below reads it
// at evaluation time (auth's SECURE_COOKIES, logger's LOG_LEVEL).
import "./loadEnv.js";
import type { Server } from "node:http";
import { createApp, createServices } from "./app.js";
import logger from "./logger.js";
import { startRoutineScheduler } from "./scheduler.js";
import { cancelAllRuns } from "./agent/runRegistry.js";
import { applyCustomGithubCa } from "./tlsCa.js";

const services = createServices();
// Trust an on-prem GitHub's internal CA (GITHUB_CA_CERT) for Node fetch and git
// before anything reaches out over HTTPS. create_repo also passes it to gh.
applyCustomGithubCa(services.config, logger);
const app = createApp(services);

const server: Server = app.listen(services.config.port, () => {
  logger.info({ port: services.config.port }, "noah-almighty listening");
  logger.info(
    { dataDir: services.config.dataDir, agentRuntime: services.config.agentRuntime },
    "server started",
  );
});

// Fire owner-scheduled routine jobs in the background.
const stopScheduler = startRoutineScheduler(services);

// A rejected promise from an async Express 4 route handler is NOT routed to the
// error middleware — it surfaces here. Log and CONTINUE: a single bad request
// must never take the whole server down. The per-route try/catch handles the
// common cases; this is the backstop for anything that slips past (e.g. a throw
// before a handler enters its try block).
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection (continuing)");
});

// An uncaught synchronous exception leaves undefined state — log and exit so the
// container restarts cleanly rather than limping along corrupted.
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception — exiting");
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  stopScheduler();
  // Abort in-flight chat runs so their cancel path persists the streamed partial
  // and ends the SSE responses (otherwise open streams would block server.close
  // until the timeout and the watched turn would be lost).
  cancelAllRuns();
  server.close(() => {
    try {
      services.store.close();
    } catch (err) {
      logger.error({ err }, "error closing store during shutdown");
    }
    logger.info("shutdown complete");
    process.exit(0);
  });
  // Hard cap: don't wait forever if a connection won't drain.
  setTimeout(() => {
    logger.warn("forced exit after shutdown timeout");
    process.exit(0);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
