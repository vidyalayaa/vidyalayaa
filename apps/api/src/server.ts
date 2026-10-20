import { assertRuntimeRole } from './lib/runtime-role.js';
import { loadConfig } from './lib/config.js';
import { createApp, createDependencies } from './app.js';
const config = loadConfig(),
  deps = createDependencies(config),
  app = createApp(config, deps);
try {
  await Promise.all([
    assertRuntimeRole(deps.api, 'app_api'),
    assertRuntimeRole(deps.device, 'app_device'),
    assertRuntimeRole(deps.platform, 'app_platform'),
  ]);
} catch (err) {
  await Promise.all([deps.api.end(), deps.device.end(), deps.platform.end()]);
  console.error(
    'DATABASE_ROLE_VALIDATION_FAILED: verify runtime logins, TLS and connectivity. Never use a migration-owner connection.',
    err,
  );
  process.exit(1);
}
const server = app.listen(config.PORT, () =>
  console.info(`Vidyalayaa API listening on ${config.PORT}`),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close(() => {
      Promise.all([deps.api.end(), deps.device.end(), deps.platform.end()]).then(() =>
        process.exit(0),
      );
    });
    setTimeout(() => process.exit(1), 15000).unref();
  });
