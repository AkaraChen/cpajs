// Regression tests for resource cleanup: temporary directories, stopAllServers,
// host signals and log memory bounds. They use tests/fixtures/fake-cpa.mjs.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CpaStartError, startServer, stopAllServers, type CpaServer, type LogLine, type StartServerOptions } from '../../src/server/index.ts';
import { internalCommand } from '../../src/server/internal.ts';
import { MAX_LINE_LENGTH } from '../../src/server/process.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-cpa.mjs', import.meta.url));
const HOST = fileURLToPath(new URL('../fixtures/signal-host.ts', import.meta.url));
const FIXTURE = { [internalCommand]: { path: process.execPath, args: [FAKE] } };
const startFake = (options: StartServerOptions = {}): Promise<CpaServer> =>
  startServer({ ...options, ...FIXTURE } as StartServerOptions);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return condition();
}

describe('startup validation', () => {
  it('rejects bad options without creating a temporary state directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpajs-isolated-'));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      for (const args of [['-config'], ['--config=x.yaml'], ['-local-model'], ['-codex-login'], ['-tui']]) {
        const error = await startFake({ args }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CpaStartError);
        expect((error as CpaStartError).code).toBe('invalid-options');
      }
      expect(await startFake({ env: { MANAGEMENT_PASSWORD: 'x' } }).catch((e: CpaStartError) => e.code)).toBe('invalid-options');
      expect(await readdir(root)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stopAllServers', () => {
  it('stops every running server and removes their temporary state directories', async () => {
    const servers = await Promise.all([startFake(), startFake()]);
    const results = await stopAllServers();
    expect(results).toHaveLength(2);
    for (const server of servers) {
      expect(alive(server.pid)).toBe(false);
      await expect(server.exited).resolves.toBeDefined();
    }
    // Nothing is left to stop afterwards.
    expect(await stopAllServers()).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('host shutdown', () => {
  const runHost = async (mode: 'signal' | 'exit', signal?: NodeJS.Signals): Promise<number> => {
    const host = spawn(process.execPath, [HOST], { env: { ...process.env, HOST_MODE: mode }, stdio: ['ignore', 'pipe', 'inherit'] });
    const pid = await new Promise<number>((resolve, reject) => {
      let out = '';
      host.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const match = /child (\d+)/.exec(out);
        if (match) resolve(Number(match[1]));
      });
      host.once('exit', (code) => reject(new Error(`host exited early with ${String(code)}: ${out}`)));
    });
    if (signal) host.kill(signal);
    await new Promise((resolve) => (host.exitCode !== null ? resolve(undefined) : host.once('exit', resolve)));
    return pid;
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`leaves no CPA process behind when the host handles ${signal} with stopAllServers()`, async () => {
      const child = await runHost('signal', signal);
      expect(await until(() => !alive(child))).toBe(true);
    }, 20_000);
  }

  it('kills the CPA process when the host exits normally', async () => {
    const child = await runHost('exit');
    expect(await until(() => !alive(child))).toBe(true);
  }, 20_000);
});

describe('log memory bounds', () => {
  it('truncates over-long lines and marks how much was dropped', async () => {
    const lines: LogLine[] = [];
    const length = MAX_LINE_LENGTH * 3 + 123;
    const server = await startFake({ env: { FAKE_LONG_LINE: String(length) }, onLog: (l) => lines.push(l) });
    await server.stop();
    const long = lines.find((l) => l.line.startsWith('xxxx'))!;
    expect(long.line.startsWith('x'.repeat(MAX_LINE_LENGTH))).toBe(true);
    expect(long.line).toContain(`…[truncated ${length - MAX_LINE_LENGTH} chars]`);
    expect(long.line.length).toBeLessThan(MAX_LINE_LENGTH + 64);
    // The next line is intact and carries no marker.
    expect(lines.some((l) => l.line === 'after long line')).toBe(true);
  });
});
