// Process lifecycle tests against tests/fixtures/fake-cpa.mjs. The fixture is
// started through the current Node executable because Windows does not honour
// the shebang line.
import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSync } from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  CpaStartError,
  startServer,
  type CpaServer,
  type ExitEvent,
  type LogLine,
  type RestartEvent,
  type RestartFailedEvent,
  type RestartedEvent,
  type CpaWarning,
  type StartServerOptions,
  type StartWithConfigOptions,
} from '../../src/server/index.ts';
import { internalCommand } from '../../src/server/internal.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-cpa.mjs', import.meta.url));
// startServer always passes `-config <file>` before any extra arguments, which
// Node does not accept as an option, so the internal launcher hook runs
// `node <fixture>` first. It is not part of the public options.
const FIXTURE = { [internalCommand]: { path: process.execPath, args: [FAKE] } };
function startFake(options: StartServerOptions = {}): Promise<CpaServer> {
  return startServer({ ...options, ...FIXTURE } as StartServerOptions);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cpajs-life-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10 });
});

async function startError(promise: Promise<unknown>): Promise<CpaStartError> {
  const error = await promise.then(
    () => {
      throw new Error('expected startServer to fail');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CpaStartError);
  return error as CpaStartError;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

describe('server lifecycle (fake binary)', () => {
  it('starts on a dynamic loopback port, reports addresses, and cleans its temp dir on stop', async () => {
    const lines: LogLine[] = [];
    const server = await startFake({ localModel: true, args: ['-plugin-flag=1'], onLog: (l) => lines.push(l) });
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.baseUrl).toBe(`${server.origin}/v1`);
    expect(server.pid).toBeGreaterThan(0);
    expect(existsSync(server.stateDir)).toBe(true);
    const health = await fetch(`${server.origin}/healthz`);
    expect(health.status).toBe(200);
    expect(lines.some((l) => l.line.includes(`-config ${server.configPath} -local-model -plugin-flag=1`))).toBe(true);

    const [a, b] = await Promise.all([server.stop(), server.stop()]);
    expect(a).toEqual(b);
    expect(await server.stop()).toEqual(a);
    expect(await server.exited).toEqual(a);
    expect(existsSync(server.stateDir)).toBe(false);
  });

  it('keeps a caller-provided stateDir and writes the managed config there', async () => {
    const server = await startFake({ stateDir: dir, config: { routing: { strategy: 'fill-first' } } });
    await server.stop();
    expect(server.configPath).toBe(join(dir, 'config.yaml'));
    const text = await readFile(server.configPath, 'utf8');
    expect(text).not.toMatch(/^\{/);
    expect(parseYaml(text).routing).toEqual({ strategy: 'fill-first' });
    expect(existsSync(dir)).toBe(true);
  });

  it('reuses an existing managed config, logs it, and overwrites on request', async () => {
    const first = await startFake({ stateDir: dir, config: { routing: { strategy: 'fill-first' } } });
    const port = first.port;
    await first.stop();

    const warnings: CpaWarning[] = [];
    const second = await startFake({ stateDir: dir,
      config: { routing: { strategy: 'round-robin' } },
      onWarning: (w) => warnings.push(w),
    });
    expect(second.port).toBe(port);
    expect(warnings.map((w) => w.code)).toContain('configReused');
    expect(parseYaml(await readFile(second.configPath, 'utf8')).routing).toEqual({ strategy: 'fill-first' });
    await second.stop();

    const third = await startFake({ stateDir: dir,
      overwriteConfig: true,
      config: { routing: { strategy: 'round-robin' } },
    });
    expect(parseYaml(await readFile(third.configPath, 'utf8')).routing).toEqual({ strategy: 'round-robin' });
    await third.stop();
  });

  it('honours an explicit port and refuses one that is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const error = await startError(startFake({ port }));
      expect(error.code).toBe('port-in-use');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    const server = await startFake({ port });
    expect(server.port).toBe(port);
    await server.stop();
  });

  it('retries another dynamic port when the bind races', async () => {
    const counter = join(dir, 'runs');
    const server = await startFake({ env: { FAKE_BIND_ERROR: '2', FAKE_COUNTER: counter } });
    expect(await readFile(counter, 'utf8')).toBe('3');
    await server.stop();

    await rm(counter);
    const error = await startError(startFake({ env: { FAKE_BIND_ERROR: '5', FAKE_COUNTER: counter } }));
    expect(error.code).toBe('port-in-use');
    expect(await readFile(counter, 'utf8')).toBe('3');
    // Six fixture runs, each spawning a port-holder process: about 1.3 s locally,
    // but slow CI runners exceeded vitest's default 5 s.
  }, 30_000);

  it('reports an early exit with code and output', async () => {
    const error = await startError(startFake({ stateDir: dir, env: { FAKE_EXIT: '3' } }));
    expect(error.code).toBe('exited');
    expect(error.exitCode).toBe(3);
    expect(error.output).toContain('fake cpa starting');
  });

  it('reports exited when the process exits with code 0 but the port is free', async () => {
    const error = await startError(startFake({ stateDir: dir, env: { FAKE_EXIT: '0' } }));
    expect(error.code).toBe('exited');
    expect(error.exitCode).toBe(0);
    expect(error.output).toContain('fake cpa starting');
  });

  it('times out, kills the process and removes the temp dir', async () => {
    // Isolate the scan: other test files (and other agents) share tmpdir().
    const root = await mkdtemp(join(tmpdir(), 'cpajs-isolated-'));
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      const error = await startError(startFake({ startupTimeoutMs: 300, env: { FAKE_DELAY_MS: '5000' } }));
      expect(error.code).toBe('timeout');
      expect(readdirSync(root)).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can be cancelled with an AbortSignal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop it')), 200);
    const error = await startError(startFake({ signal: controller.signal, env: { FAKE_DELAY_MS: '5000' } }));
    expect(error.code).toBe('aborted');
    expect(error.cause).toEqual(new Error('stop it'));
  });

  it('strips CRLF line endings from output', async () => {
    const lines: LogLine[] = [];
    const server = await startFake({ env: { FAKE_CRLF: '1' }, onLog: (l) => lines.push(l) });
    await server.stop();
    expect(lines.some((l) => l.stream === 'stdout' && l.line === 'crlf stdout line')).toBe(true);
    expect(lines.some((l) => l.stream === 'stderr' && l.line === 'crlf stderr line')).toBe(true);
    expect(lines.some((l) => l.line.includes('\r'))).toBe(false);
  });

  it('stops a process that does not handle the termination signal', async () => {
    const server = await startFake({ env: { FAKE_IGNORE_TERM: '1' } });
    const started = Date.now();
    const exit = await server.stop({ timeoutMs: 300 });
    const elapsed = Date.now() - started;
    if (process.platform === 'win32') {
      // There is no graceful signal on Windows: Node terminates the process
      // forcefully and reports the emulated SIGTERM.
      expect(exit.signal).toBe('SIGTERM');
      expect(elapsed).toBeLessThan(5_000);
    } else {
      expect(exit.signal).toBe('SIGKILL');
      expect(elapsed).toBeGreaterThanOrEqual(250);
    }
  });

  it('resolves exited when the process dies on its own', async () => {
    const server = await startFake();
    process.kill(server.pid, 'SIGKILL');
    const expected = process.platform === 'win32' ? { code: 1, signal: null } : { code: null, signal: 'SIGKILL' };
    expect(await server.exited).toEqual(expected);
    expect(await server.stop()).toEqual(expected);
    expect(existsSync(server.stateDir)).toBe(false);
  });

  it('hashes the management key into the managed config and keeps it out of the environment', async () => {
    const lines: LogLine[] = [];
    const key = 'mgmt-secret-value';
    const server = await startFake({ stateDir: dir,
      management: { key },
      config: { access: { 'api-keys': ['model-secret-value'] } },
      redact: ['extra-secret-value'],
      env: { FAKE_ECHO: 'mgmt-secret-value model-secret-value extra-secret-value' },
      onLog: (l) => lines.push(l),
    });
    await server.stop();
    const echoed = lines.filter((l) => l.line.includes('[REDACTED]'));
    expect(echoed.map((l) => l.stream).sort()).toEqual(['stderr', 'stdout']);
    expect(echoed[0]!.line).toMatch(/: \[REDACTED\] \[REDACTED\] \[REDACTED\]$/);
    expect(server.recentLogs.some((l) => l.line.includes('secret-value'))).toBe(false);
    expect('managementKey' in server).toBe(false);
    expect(lines.some((l) => l.line.startsWith('MANAGEMENT_PASSWORD'))).toBe(false);

    const written = parseYaml(await readFile(server.configPath, 'utf8'));
    expect(written.management['secret-key']).toMatch(/^\$2[aby]\$10\$/);
    expect(written.management['secret-key']).not.toContain(key);
    expect(compareSync(key, written.management['secret-key'])).toBe(true);
    expect(written.management['allow-remote']).toBe(false);
  });

  it('keeps a reused config untouched for the same key and updates only the hash for a new one', async () => {
    const start = async (key: string, warnings: CpaWarning[]) =>
      (await startFake({ stateDir: dir, management: { key }, onWarning: (w) => warnings.push(w) })).stop();

    await start('first-key-value', []);
    const configPath = join(dir, 'config.yaml');
    // Simulate a change CPA persisted through the management API.
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}routing:\n  strategy: fill-first\n`);
    const before = await readFile(configPath, 'utf8');

    const same: CpaWarning[] = [];
    await start('first-key-value', same);
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(same.map((w) => w.code)).not.toContain('managementKeyUpdated');

    const changed: CpaWarning[] = [];
    await start('second-key-value', changed);
    const after = parseYaml(await readFile(configPath, 'utf8'));
    expect(changed.map((w) => w.code)).toContain('managementKeyUpdated');
    expect(compareSync('second-key-value', after.management['secret-key'])).toBe(true);
    expect(compareSync('first-key-value', after.management['secret-key'])).toBe(false);
    expect(after.routing).toEqual({ strategy: 'fill-first' });
  });

  it('drops an inherited MANAGEMENT_PASSWORD in the default mode', async () => {
    const saved = process.env.MANAGEMENT_PASSWORD;
    process.env.MANAGEMENT_PASSWORD = 'inherited-value';
    try {
      const lines: LogLine[] = [];
      const server = await startFake({ stateDir: dir,
        management: { key: 'chosen-key' },
        onLog: (l) => lines.push(l),
      });
      await server.stop();
      expect(lines.some((l) => l.line.startsWith('MANAGEMENT_PASSWORD'))).toBe(false);
      const written = parseYaml(await readFile(server.configPath, 'utf8'));
      expect(compareSync('chosen-key', written.management['secret-key'])).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.MANAGEMENT_PASSWORD;
      else process.env.MANAGEMENT_PASSWORD = saved;
    }
  });

  it('never passes an inherited MANAGEMENT_PASSWORD when no management key is given', async () => {
    const saved = process.env.MANAGEMENT_PASSWORD;
    process.env.MANAGEMENT_PASSWORD = 'inherited-value';
    try {
      const lines: LogLine[] = [];
      const server = await startFake({ stateDir: dir, onLog: (l) => lines.push(l) });
      await server.stop();
      expect(lines.some((l) => l.line.startsWith('MANAGEMENT_PASSWORD'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MANAGEMENT_PASSWORD;
      else process.env.MANAGEMENT_PASSWORD = saved;
    }
  });

  it('can pass the key through MANAGEMENT_PASSWORD when explicitly requested', async () => {
    const lines: LogLine[] = [];
    const server = await startFake({ stateDir: dir,
      management: { key: 'mgmt-secret-value', viaEnvironment: true },
      onLog: (l) => lines.push(l),
    });
    await server.stop();
    expect(lines.some((l) => l.line === 'MANAGEMENT_PASSWORD length 17')).toBe(true);
    expect('managementKey' in server).toBe(false);
    const written = parseYaml(await readFile(server.configPath, 'utf8'));
    expect(written.management).toBeUndefined();
  });

  it('warns when remote management is exposed on a non-loopback host', async () => {
    const warn = async (options: Pick<StartWithConfigOptions, 'management' | 'host'>): Promise<string[]> => {
      const warnings: CpaWarning[] = [];
      const server = await startFake({ host: '0.0.0.0', onWarning: (w) => warnings.push(w), ...options });
      await server.stop();
      return warnings.filter((w) => w.message.includes('reachable from non-loopback')).map((w) => w.code);
    };

    expect(await warn({ management: { key: 'k', allowRemote: true } })).toEqual(['remoteManagementExposed']);
    expect(await warn({ management: { key: 'k', viaEnvironment: true } })).toEqual(['managementViaEnvironment']);
    // viaEnvironment is warned about even on loopback: plaintext comparison and forced remote access.
    const warnings: CpaWarning[] = [];
    const local = await startFake({ host: '127.0.0.1', management: { key: 'k', viaEnvironment: true }, onWarning: (w) => warnings.push(w) });
    await local.stop();
    const viaEnv = warnings.filter((w) => w.code === 'managementViaEnvironment');
    expect(viaEnv).toHaveLength(1);
    expect(viaEnv[0]!.message).not.toContain('reachable from non-loopback');
    // The default mode stays local, so binding all interfaces is not a remote-management warning.
    expect(await warn({ management: { key: 'k' } })).toEqual([]);
    // Loopback with remote access enabled is still local.
    expect(
      await warn({ host: '127.0.0.1', management: { key: 'k', allowRemote: true } }),
    ).toEqual([]);
  });

  it('rejects a configPath secret together with management viaEnvironment', async () => {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'config-version: 8\nserver:\n  host: 127.0.0.1\n  port: 12345\nmanagement:\n  secret-key: file-secret\n');
    const error = await startError(
      startFake({ configPath, management: { key: 'env-key', viaEnvironment: true } }),
    );
    expect(error.code).toBe('invalid-options');
    expect(error.message).toMatch(/configPath/);
  });

  it('passes Home options as a flag plus HOME_JWT, keeping the JWT out of argv and logs', async () => {
    const lines: LogLine[] = [];
    const server = await startFake({
      home: { jwt: 'home-jwt-secret-value', disableClusterDiscovery: true },
      env: { FAKE_ECHO: 'home-jwt-secret-value' },
      onLog: (l) => lines.push(l),
    });
    await server.stop();
    const argv = lines.find((l) => l.line.startsWith('fake cpa starting'))!.line;
    expect(argv).toContain('-home-disable-cluster-discovery');
    expect(argv).not.toContain('home-jwt-secret-value');
    expect(lines.some((l) => l.line === 'HOME_JWT length 21')).toBe(true);
    expect(lines.some((l) => l.line.includes('home-jwt-secret-value'))).toBe(false);
  });

  it('reports a binary that cannot be executed', async () => {
    const bogus = join(dir, process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api');
    await writeFile(bogus, Buffer.from([0, 1, 2, 3]));
    await chmod(bogus, 0o755);
    const error = await startError(startServer({ binaryPath: bogus }));
    // libuv reports exec failures either as a spawn error or as exit code 127, depending on the OS.
    expect(['spawn-failed', 'exited']).toContain(error.code);
    if (error.code === 'exited') expect(error.exitCode).toBe(127);
  });

  describe('restart', () => {
    it('keeps the handle and port, swaps process details, and preserves stateDir and config', async () => {
      const counter = join(dir, 'runs');
      const server = await startFake({ config: { routing: { strategy: 'fill-first' }, access: { 'api-keys': ['model-key'] } },
        env: { FAKE_COUNTER: counter },
      });
      const origin = server.origin;
      const baseUrl = server.baseUrl;
      const host = server.host;
      const port = server.port;
      const stateDir = server.stateDir;
      const configPath = server.configPath;
      const firstPid = server.pid;
      const firstProcess = server.process;
      const firstLogs = server.recentLogs;
      let exits = 0;
      void server.exited.then(() => {
        exits++;
      });

      // Simulate a runtime management-API change plus a credential written to stateDir.
      const runtime = parseYaml(await readFile(configPath, 'utf8'));
      runtime.routing = { strategy: 'round-robin' };
      await writeFile(configPath, stringifyYaml(runtime));
      await writeFile(join(stateDir, 'auths', 'marker.json'), '{"type":"claude"}');

      await server.restart();
      expect(server.origin).toBe(origin);
      expect(server.baseUrl).toBe(baseUrl);
      expect(server.host).toBe(host);
      expect(server.port).toBe(port);
      expect(server.stateDir).toBe(stateDir);
      expect(server.configPath).toBe(configPath);
      expect(server.pid).not.toBe(firstPid);
      expect(server.process).not.toBe(firstProcess);
      expect(server.process.pid).toBe(server.pid);
      expect(server.recentLogs.includes(firstLogs[0]!)).toBe(false);
      expect(server.recentLogs.filter((l) => l.line.startsWith('fake cpa starting'))).toHaveLength(1);
      expect(exits).toBe(0);
      expect(await readFile(counter, 'utf8')).toBe('2');
      expect(existsSync(stateDir)).toBe(true);
      expect(existsSync(join(stateDir, 'auths', 'marker.json'))).toBe(true);
      // restart must not rewrite config.yaml, otherwise runtime edits would be lost.
      expect(parseYaml(await readFile(configPath, 'utf8')).routing).toEqual({ strategy: 'round-robin' });

      const exit = await server.stop();
      expect(await server.exited).toEqual(exit);
      expect(exits).toBe(1);
      expect(existsSync(stateDir)).toBe(false);
    });

    it('shares one operation between concurrent restart calls', async () => {
      const counter = join(dir, 'runs');
      const server = await startFake({ env: { FAKE_COUNTER: counter } });
      const first = server.restart();
      const second = server.restart();
      expect(second).toBe(first);
      await first;
      expect(await readFile(counter, 'utf8')).toBe('2');
      await server.stop();
    });

    it('aborts an in-flight restart when stop() is called', async () => {
      const counter = join(dir, 'runs');
      const server = await startFake({ env: { FAKE_COUNTER: counter, FAKE_DELAY_AFTER: '1', FAKE_DELAY_MS: '5000' },
      });
      const restarting = startError(server.restart());
      await waitFor(async () => (await readFile(counter, 'utf8')) === '2');
      const [error, exit] = await Promise.all([restarting, server.stop()]);
      expect(error.code).toBe('aborted');
      expect(await server.exited).toEqual(exit);
      expect(existsSync(server.stateDir)).toBe(false);
      await expect(server.restart()).rejects.toMatchObject({ code: 'stopped' });
    });

    it('fails with port-in-use instead of switching ports, and cleans up', async () => {
      const counter = join(dir, 'runs');
      const server = await startFake({ env: { FAKE_COUNTER: counter, FAKE_DELAY_AFTER: '1', FAKE_DELAY_MS: '1500' },
      });
      const stateDir = server.stateDir;
      const restarting = startError(server.restart());
      await waitFor(async () => (await readFile(counter, 'utf8')) === '2');
      const blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(server.port, '127.0.0.1', () => resolve());
      });
      try {
        const error = await restarting;
        expect(error.code).toBe('port-in-use');
      } finally {
        blocker.close();
      }
      expect(existsSync(stateDir)).toBe(false);
      const exit = await server.stop();
      expect(await server.exited).toEqual(exit);
      await expect(server.restart()).rejects.toMatchObject({ code: 'stopped' });
    });

    it('fails an already-aborted restart and leaves the server stopped', async () => {
      const server = await startFake();
      const error = await startError(server.restart({ signal: AbortSignal.abort(new Error('nope')) }));
      expect(error.code).toBe('aborted');
      expect(error.cause).toEqual(new Error('nope'));
      expect(existsSync(server.stateDir)).toBe(false);
      await server.stop();
      await expect(server.restart()).rejects.toMatchObject({ code: 'stopped' });
    });

    it('resolves exited once when the restarted process dies on its own', async () => {
      const server = await startFake();
      await server.restart();
      process.kill(server.pid, 'SIGKILL');
      const expected = process.platform === 'win32' ? { code: 1, signal: null } : { code: null, signal: 'SIGKILL' };
      expect(await server.exited).toEqual(expected);
      expect(await server.stop()).toEqual(expected);
      expect(existsSync(server.stateDir)).toBe(false);
    });
  });

  describe('auto restart', () => {
    it('restarts after an unexpected exit and keeps the handle and client usable', async () => {
      const counter = join(dir, 'runs');
      const server = await startFake({ env: { FAKE_COUNTER: counter }, restart: { onUnexpectedExit: true, backoffMs: [50] } });
      const origin = server.origin;
      const port = server.port;
      const client = server.client();
      const oldPid = server.pid;
      let exits = 0;
      void server.exited.then(() => {
        exits++;
      });

      const events: string[] = [];
      server.on('exit', (e) => events.push(`exit:${e.willRestart}`));
      server.on('restart', (e) => events.push(`restart:${e.reason}:${e.attempt}`));
      server.on('restarted', (e) => events.push(`restarted:${e.reason}:${e.attempt}:${e.originChanged}`));

      process.kill(server.pid, 'SIGKILL');
      await waitFor(async () => server.pid !== oldPid && (await fetch(`${server.origin}/healthz`)).ok);

      expect(server.origin).toBe(origin);
      expect(server.port).toBe(port);
      expect(events).toEqual(['exit:true', 'restart:unexpected-exit:1', 'restarted:unexpected-exit:1:false']);
      expect(exits).toBe(0);
      expect(await readFile(counter, 'utf8')).toBe('2');
      // The client is bound to the original origin and key, so it just keeps working.
      const health = await client.request<{ status: string }>({ method: 'GET', path: '/healthz', root: true, anonymous: true });
      expect(health.data).toEqual({ status: 'ok' });

      const exit = await server.stop();
      expect(await server.exited).toEqual(exit);
      expect(exits).toBe(1);
    });

    it('auto-restarts in configPath mode', async () => {
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const configPath = join(dir, 'config.yaml');
      await writeFile(configPath, `config-version: 8\nserver:\n  host: 127.0.0.1\n  port: ${port}\n`);

      const server = await startFake({ configPath, restart: { onUnexpectedExit: true, backoffMs: [30] } });
      const oldPid = server.pid;
      const restarted = new Promise<RestartedEvent>((resolve) => server.on('restarted', resolve));
      process.kill(server.pid, 'SIGKILL');
      await restarted;

      expect(server.pid).not.toBe(oldPid);
      expect(server.configPath).toBe(configPath);
      expect(server.port).toBe(port);
      await server.stop();
    });

    it('follows the backoff sequence and gives up after maxAttempts', async () => {
      const counter = join(dir, 'runs');
      // Runs 2 and later exit before becoming ready, so every restart attempt fails.
      const server = await startFake({
        env: { FAKE_COUNTER: counter, FAKE_EXIT: '1', FAKE_EXIT_AFTER: '2' },
        restart: { onUnexpectedExit: true, backoffMs: [60, 120, 180], maxAttempts: 3 },
      });
      const restarts: number[] = [];
      const failures: RestartFailedEvent[] = [];
      server.on('restart', () => restarts.push(Date.now()));
      server.on('restart-failed', (e) => failures.push(e));

      const killedAt = Date.now();
      process.kill(server.pid, 'SIGKILL');
      const exit = await server.exited;

      expect(exit).toEqual({ code: 1, signal: null });
      expect(restarts).toHaveLength(3);
      expect(failures.map((f) => f.attempt)).toEqual([1, 2, 3]);
      expect(failures.map((f) => f.willRetry)).toEqual([true, true, false]);
      expect(restarts[0]! - killedAt).toBeGreaterThanOrEqual(50);
      expect(restarts[1]! - restarts[0]!).toBeGreaterThanOrEqual(110);
      expect(restarts[2]! - restarts[1]!).toBeGreaterThanOrEqual(170);
      expect(await readFile(counter, 'utf8')).toBe('4');
      expect(existsSync(server.stateDir)).toBe(false);
      expect(await server.stop()).toEqual(exit);
      await expect(server.restart()).rejects.toMatchObject({ code: 'stopped' });
    });

    it('cancels the backoff on stop() and settles without another start', async () => {
      const counter = join(dir, 'runs');
      const server = await startFake({ env: { FAKE_COUNTER: counter }, restart: { onUnexpectedExit: true, backoffMs: [10_000] } });
      const restarts: RestartEvent[] = [];
      server.on('restart', (e) => restarts.push(e));
      const exitedEvent = new Promise<ExitEvent>((resolve) => server.on('exit', resolve));

      process.kill(server.pid, 'SIGKILL');
      expect((await exitedEvent).willRestart).toBe(true);

      const started = Date.now();
      const exit = await server.stop();
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(restarts).toHaveLength(0);
      expect(await readFile(counter, 'utf8')).toBe('1');
      expect(await server.exited).toEqual(exit);
      expect(existsSync(server.stateDir)).toBe(false);
    });

    it('restarts immediately when restart() is called during a backoff', async () => {
      const counter = join(dir, 'runs');
      const server = await startFake({ env: { FAKE_COUNTER: counter }, restart: { onUnexpectedExit: true, backoffMs: [10_000] } });
      const oldPid = server.pid;
      const events: string[] = [];
      server.on('restarted', (e) => events.push(`${e.reason}:${e.attempt}:${e.originChanged}`));
      const exitedEvent = new Promise<void>((resolve) => server.on('exit', () => resolve()));

      process.kill(server.pid, 'SIGKILL');
      await exitedEvent;

      const started = Date.now();
      await server.restart();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(server.pid).not.toBe(oldPid);
      expect(await readFile(counter, 'utf8')).toBe('2');
      expect(events).toEqual(['manual:1:false']);
      await server.stop();
    });

    it('reports willRestart=false without auto restart', async () => {
      const server = await startFake();
      let event: ExitEvent | undefined;
      server.on('exit', (e) => {
        event = e;
      });
      process.kill(server.pid, 'SIGKILL');
      await server.exited;
      expect(event?.willRestart).toBe(false);
      await server.stop();
    });

    it('ignores a throwing listener and reports it as a warning', async () => {
      const server = await startFake({ restart: { onUnexpectedExit: true, backoffMs: [30] } });
      const warnings: string[] = [];
      const capture = (warning: Error): void => {
        warnings.push(warning.message);
      };
      process.on('warning', capture);
      try {
        server.on('exit', () => {
          throw new Error('listener boom');
        });
        const restarted = new Promise<RestartedEvent>((resolve) => server.on('restarted', resolve));
        process.kill(server.pid, 'SIGKILL');
        expect(await restarted).toMatchObject({ reason: 'unexpected-exit', attempt: 1, originChanged: false });
        expect(warnings.some((w) => w.includes("'exit' listener threw") && w.includes('listener boom'))).toBe(true);
      } finally {
        process.off('warning', capture);
        await server.stop();
      }
    });
  });
});
