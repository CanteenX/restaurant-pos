import { createControlApi } from './bootstrap.js';

async function main() {
  const { app, port } = await createControlApi(process.env);
  app.enableShutdownHooks();
  await app.listen(port, '0.0.0.0');
}

void main().catch(() => {
  process.stderr.write(
    'Control API failed to start. Check CONTROL_API_PORT and listener availability.\n',
  );
  process.exitCode = 1;
});
