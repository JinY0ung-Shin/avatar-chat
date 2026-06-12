// MUST be first: loads .env into process.env before any module below reads it
// at evaluation time (auth's SECURE_COOKIES, logger's LOG_LEVEL).
import "./loadEnv.js";
import { createApp, createServices } from "./app.js";
import logger from "./logger.js";
import { startRoutineScheduler } from "./scheduler.js";
import { applyCustomGithubCa } from "./tlsCa.js";

const services = createServices();
// Trust an on-prem GitHub's internal CA (GITHUB_CA_CERT) for both the fetch and
// git TLS stacks before anything reaches out over HTTPS.
applyCustomGithubCa(services.config, logger);
const app = createApp(services);

app.listen(services.config.port, () => {
  logger.info({ port: services.config.port }, "noah-almighty listening");
  logger.info(
    { dataDir: services.config.dataDir, agentRuntime: services.config.agentRuntime },
    "server started",
  );
});

// Fire owner-scheduled routine jobs in the background.
startRoutineScheduler(services);
