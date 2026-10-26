// The real CPA must not outlive a host that is killed with SIGKILL, and its port
// must be free again so the next start succeeds (the reported tsx/nodemon case).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findFreePort, isPortFree } from '../../src/server/readiness.ts';
import { startServer } from '../../src/server/index.ts';
import { findBinary } from './helpers.ts';

const binary = findBinary();
const HOST = fileURLToPath(new URL('../fixtures/cpa-host.ts', import.meta.url));
const hasLauncher = binary !== undefined && existsSync(join(dirname(binary), 'cpa-launcher'));

describe.skipIf(!binary || !hasLauncher || process.platform === 'win32')('cpa-launcher with the real CPA', () => {
  it('stops CPA and frees its port when the host is SIGKILLed', async () => {
    const reservation = await findFreePort('127.0.0.1');
    const port = reservation.port;
    await reservation.release();

    const host = spawn(process.execPath, [HOST], { env: { ...process.env, CPA_BINARY: binary, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
    const cpa = await new Promise<number>((resolve, reject) => {
      let out = '';
      host.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const match = /cpa (\d+)/.exec(out);
        if (match) resolve(Number(match[1]));
      });
      host.once('exit', (code) => reject(new Error(`host exited early (${String(code)}): ${out}`)));
    });
    expect(await isPortFree('127.0.0.1', port)).toBe(false);

    host.kill('SIGKILL');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await isPortFree('127.0.0.1', port))) await new Promise((r) => setTimeout(r, 100));
    expect(await isPortFree('127.0.0.1', port)).toBe(true);
    expect(() => process.kill(cpa, 0)).toThrow();

    // The next start on the same port works.
    const next = await startServer({ binaryPath: binary!, port, localModel: true });
    expect(next.port).toBe(port);
    await next.stop();
  }, 60_000);
});
