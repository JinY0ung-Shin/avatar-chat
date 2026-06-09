import { createApp, createServices } from "./app.js";

const services = createServices();
const app = createApp(services);

app.listen(services.config.port, () => {
  console.log(`avatar-chat listening on http://0.0.0.0:${services.config.port}`);
  // Eager-warm the marketplace registry so plugins are installed/loaded at
  // boot instead of lazily on the first request. Never crash the process on a
  // registry failure — surface it and let the status endpoint report it.
  services
    .getRegistry()
    .then((registry) => {
      console.log(`marketplace ready: ${registry.plugins.length} plugin(s) loaded from "${registry.name}"`);
      if (registry.warnings.length > 0) {
        console.warn(`marketplace warnings: ${registry.warnings.join("; ")}`);
      }
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`marketplace warm-up failed: ${detail}`);
    });
});
