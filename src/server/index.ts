import { createApp, createServices } from "./app.js";
import logger from "./logger.js";
import { startRoutineScheduler } from "./scheduler.js";

const services = createServices();
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
