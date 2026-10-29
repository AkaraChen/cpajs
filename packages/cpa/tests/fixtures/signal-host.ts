// Host process for the signal-cleanup test. It starts the fake CPA through
// startServer, prints the child's pid, and handles shutdown as the README
// recommends: on SIGINT/SIGTERM it calls stopAllServers() and exits.
// HOST_MODE=exit instead calls process.exit(0) right away (normal exit path).
import { fileURLToPath } from 'node:url';
import { startServer, stopAllServers, type StartServerOptions } from '../../src/server/index.ts';
import { internalCommand } from '../../src/server/internal.ts';

const FAKE = fileURLToPath(new URL('./fake-cpa.mjs', import.meta.url));
const server = await startServer({ [internalCommand]: { path: process.execPath, args: [FAKE] } } as StartServerOptions);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await stopAllServers();
    process.exit(0);
  });
}
console.log(`child ${server.pid}`);
if (process.env.HOST_MODE === 'exit') process.exit(0);
setInterval(() => {}, 1_000);
