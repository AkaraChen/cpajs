// cpa-launcher behaviour with the fake CPA: CPA must not outlive its host, and
// stop/restart/exit reporting must work the same as without the launcher.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CpaStartError, startServer, type CpaServer, type LogLine, type StartServerOptions } from '../../src/server/index.ts';
import { internalCommand } from '../../src/server/internal.ts';
import { TEST_LAUNCHER } from '../setup/launcher.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-cpa.mjs', import.meta.url));
const HOST = fileURLToPath(new URL('../fixtures/launcher-host.ts', import.meta.url));
type Mode = 'exec' | 'supervise';

const available = process.platform !== 'win32' && existsSync(TEST_LAUNCHER);
const modes: Mode[] = process.platform === 'linux' ? ['exec', 'supervise'] : ['supervise'];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return condition();
}

/** Starts the fake CPA through the launcher and resolves the fake's own pid from its output. */
async function startWithLauncher(mode: Mode, options: StartServerOptions = {}): Promise<{ server: CpaServer; cpaPid: () => number | undefined }> {
  let cpaPid: number | undefined;
  const onLog = options.onLog;
  const withLauncher = {
    ...options,
    onLog: (log: LogLine) => {
      const match = /^fake cpa pid (\d+)$/.exec(log.line);
      if (match) cpaPid = Number(match[1]);
      onLog?.(log);
    },
    [internalCommand]: { path: process.execPath, args: [FAKE], launcher: { path: TEST_LAUNCHER, mode } },
  };
  const server = await startServer(withLauncher as unknown as StartServerOptions);
  return { server, cpaPid: () => cpaPid };
}

describe.skipIf(!available)('cpa-launcher', () => {
  for (const mode of modes) {
    describe(mode, () => {
      it('stops CPA when the host is killed with SIGKILL', async () => {
        const host = spawn(process.execPath, [HOST], {
          env: { ...process.env, LAUNCHER_PATH: TEST_LAUNCHER, LAUNCHER_MODE: mode },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        const pids = await new Promise<{ cpa: number; server: number }>((resolve, reject) => {
          let out = '';
          host.stdout!.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            const cpa = /cpa (\d+)/.exec(out);
            const server = /server (\d+)/.exec(out);
            if (cpa && server) resolve({ cpa: Number(cpa[1]), server: Number(server[1]) });
          });
          host.once('exit', (code) => reject(new Error(`host exited early (${String(code)}): ${out}`)));
        });
        // exec mode replaces the launcher with CPA; supervise mode keeps the launcher as its parent.
        if (mode === 'exec') expect(pids.server).toBe(pids.cpa);
        else expect(pids.server).not.toBe(pids.cpa);
        expect(alive(pids.cpa)).toBe(true);

        host.kill('SIGKILL');
        expect(await until(() => !alive(pids.cpa), 15_000)).toBe(true);
      }, 30_000);

      it('stops on SIGTERM and reports the same exit as without the launcher', async () => {
        const { server, cpaPid } = await startWithLauncher(mode);
        const exit = await server.stop();
        // The fake has no SIGTERM handler, so it dies by the signal; supervise mode
        // must relay that outcome instead of reporting its own exit code.
        expect(exit).toEqual({ code: null, signal: 'SIGTERM' });
        expect(alive(cpaPid()!)).toBe(false);
      });

      it('kills CPA when it ignores SIGTERM past the grace period', async () => {
        const { server, cpaPid } = await startWithLauncher(mode, { env: { FAKE_IGNORE_TERM: '1' } });
        await server.stop({ timeoutMs: 300 });
        expect(await until(() => !alive(cpaPid()!), 5_000)).toBe(true);
      });

      it('relays an early exit code', async () => {
        const error = (await startWithLauncher(mode, { env: { FAKE_EXIT: '3' } }).catch((e: unknown) => e)) as CpaStartError;
        expect(error).toBeInstanceOf(CpaStartError);
        expect(error.code).toBe('exited');
        expect(error.exitCode).toBe(3);
      });

      it('relays death by signal', async () => {
        const { server, cpaPid } = await startWithLauncher(mode);
        process.kill(cpaPid()!, 'SIGKILL');
        expect(await server.exited).toEqual({ code: null, signal: 'SIGKILL' });
      });

      it('restarts through the launcher', async () => {
        const { server, cpaPid } = await startWithLauncher(mode);
        const first = cpaPid()!;
        await server.restart();
        expect(await until(() => cpaPid() !== first, 5_000)).toBe(true);
        expect(alive(first)).toBe(false);
        expect(alive(cpaPid()!)).toBe(true);
        await server.stop();
        expect(alive(cpaPid()!)).toBe(false);
      });
    });
  }
});
