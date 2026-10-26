// Host process for the launcher tests: starts the fake CPA through cpa-launcher
// (LAUNCHER_PATH, LAUNCHER_MODE=exec|supervise), prints `cpa <pid>` with the fake's
// own pid and `server <pid>` with the handle's pid, then idles until killed.
// It installs no signal handlers: the point is to die without cleaning up.
import { fileURLToPath } from 'node:url';
import { startServer, type StartServerOptions } from '../../src/server/index.ts';
import { internalCommand } from '../../src/server/internal.ts';

const FAKE = fileURLToPath(new URL('./fake-cpa.mjs', import.meta.url));
const launcher = process.env.LAUNCHER_PATH ? { path: process.env.LAUNCHER_PATH, mode: process.env.LAUNCHER_MODE as 'exec' | 'supervise' } : undefined;
const server = await startServer({
  [internalCommand]: { path: process.execPath, args: [FAKE], launcher },
  onLog: ({ line }) => {
    const match = /^fake cpa pid (\d+)$/.exec(line);
    if (match) console.log(`cpa ${match[1]}`);
  },
} as StartServerOptions);
console.log(`server ${server.pid}`);
setInterval(() => {}, 1_000);
