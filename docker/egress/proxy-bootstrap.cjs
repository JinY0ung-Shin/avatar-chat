// Use the application's pinned undici; Node's built-in fetch shares its global
// dispatcher. Clients that ignore this preload fail closed at the firewall.
const { EnvHttpProxyAgent, setGlobalDispatcher } = require('/app/node_modules/undici');
setGlobalDispatcher(new EnvHttpProxyAgent());
