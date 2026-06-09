import { createApp, createServices } from "./app.js";

const services = createServices();
const app = createApp(services);

app.listen(services.config.port, () => {
  console.log(`avatar-chat listening on http://0.0.0.0:${services.config.port}`);
});
