// Process lifecycle tests against tests/fixtures/fake-cpa.mjs (POSIX only:
// the fixture is started through its shebang).
import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSync } from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { CpaStartError, startServer, type LogLine, type StartWithConfigOptions } from '../../src/server/index.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-cpa.mjs', import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cpajs-life-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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

describe.skipIf(process.platform === 'win32')('server lifecycle (fake binary)', () => {
  it('starts on a dynamic loopback port, reports addresses, and cleans its temp dir on stop', async () => {
    const lines: LogLine[] = [];
    const server = await startServer({ binaryPath: FAKE, localModel: true, args: ['-plugin-flag=1'], onLog: (l) => lines.push(l) });
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
    const server = await startServer({ binaryPath: FAKE, stateDir: dir, config: { routing: { strategy: 'fill-first' } } });
    await server.stop();
    expect(server.configPath).toBe(join(dir, 'config.yaml'));
    const text = await readFile(server.configPath, 'utf8');
    expect(text).not.toMatch(/^\{/);
    expect(parseYaml(text).routing).toEqual({ strategy: 'fill-first' });
    expect(existsSync(dir)).toBe(true);
  });

  it('reuses an existing managed config, logs it, and overwrites on request', async () => {
    const first = await startServer({ binaryPath: FAKE, stateDir: dir, config: { routing: { strategy: 'fill-first' } } });
    const port = first.port;
    await first.stop();

    const lines: LogLine[] = [];
    const second = await startServer({
      binaryPath: FAKE,
      stateDir: dir,
      config: { routing: { strategy: 'round-robin' } },
      onLog: (l) => lines.push(l),
    });
    expect(second.port).toBe(port);
    expect(lines.some((l) => l.line.includes('Keeping existing config'))).toBe(true);
    expect(parseYaml(await readFile(second.configPath, 'utf8')).routing).toEqual({ strategy: 'fill-first' });
    await second.stop();

    const third = await startServer({
      binaryPath: FAKE,
      stateDir: dir,
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
      const error = await startError(startServer({ binaryPath: FAKE, port }));
      expect(error.code).toBe('port-in-use');
    } finally {
      blocker.close();
    }
    const server = await startServer({ binaryPath: FAKE, port });
    expect(server.port).toBe(port);
    await server.stop();
  });

  it('retries another dynamic port when the bind races', async () => {
    const counter = join(dir, 'runs');
    const server = await startServer({ binaryPath: FAKE, env: { FAKE_BIND_ERROR: '2', FAKE_COUNTER: counter } });
    expect(await readFile(counter, 'utf8')).toBe('3');
    await server.stop();

    await rm(counter);
    const error = await startError(startServer({ binaryPath: FAKE, env: { FAKE_BIND_ERROR: '5', FAKE_COUNTER: counter } }));
    expect(error.code).toBe('port-in-use');
    expect(await readFile(counter, 'utf8')).toBe('3');
  });

  it('reports an early exit with code and output', async () => {
    const error = await startError(startServer({ binaryPath: FAKE, stateDir: dir, env: { FAKE_EXIT: '3' } }));
    expect(error.code).toBe('exited');
    expect(error.exitCode).toBe(3);
    expect(error.output).toContain('fake cpa starting');
  });

  it('reports exited when the process exits with code 0 but the port is free', async () => {
    const error = await startError(startServer({ binaryPath: FAKE, stateDir: dir, env: { FAKE_EXIT: '0' } }));
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
      const error = await startError(startServer({ binaryPath: FAKE, startupTimeoutMs: 300, env: { FAKE_DELAY_MS: '5000' } }));
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
    const error = await startError(startServer({ binaryPath: FAKE, signal: controller.signal, env: { FAKE_DELAY_MS: '5000' } }));
    expect(error.code).toBe('aborted');
    expect(error.cause).toEqual(new Error('stop it'));
  });

  it('kills a process that ignores SIGTERM after the grace period', async () => {
    const server = await startServer({ binaryPath: FAKE, env: { FAKE_IGNORE_TERM: '1' } });
    const started = Date.now();
    const exit = await server.stop({ timeoutMs: 300 });
    expect(exit.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('resolves exited when the process dies on its own', async () => {
    const server = await startServer({ binaryPath: FAKE });
    process.kill(server.pid, 'SIGKILL');
    expect(await server.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await server.stop()).toEqual({ code: null, signal: 'SIGKILL' });
    expect(existsSync(server.stateDir)).toBe(false);
  });

  it('hashes the management key into the managed config and keeps it out of the environment', async () => {
    const lines: LogLine[] = [];
    const key = 'mgmt-secret-value';
    const server = await startServer({
      binaryPath: FAKE,
      stateDir: dir,
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
    expect(server.managementKey).toBe(key);
    expect(lines.some((l) => l.line.startsWith('MANAGEMENT_PASSWORD'))).toBe(false);

    const written = parseYaml(await readFile(server.configPath, 'utf8'));
    expect(written.management['secret-key']).toMatch(/^\$2[aby]\$10\$/);
    expect(written.management['secret-key']).not.toContain(key);
    expect(compareSync(key, written.management['secret-key'])).toBe(true);
    expect(written.management['allow-remote']).toBe(false);
  });

  it('keeps a reused config untouched for the same key and updates only the hash for a new one', async () => {
    const start = async (key: string, lines: LogLine[]) =>
      (await startServer({ binaryPath: FAKE, stateDir: dir, management: { key }, onLog: (l) => lines.push(l) })).stop();

    await start('first-key-value', []);
    const configPath = join(dir, 'config.yaml');
    // Simulate a change CPA persisted through the management API.
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}routing:\n  strategy: fill-first\n`);
    const before = await readFile(configPath, 'utf8');

    const same: LogLine[] = [];
    await start('first-key-value', same);
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(same.some((l) => l.line.startsWith('Updated management.secret-key'))).toBe(false);

    const changed: LogLine[] = [];
    await start('second-key-value', changed);
    const after = parseYaml(await readFile(configPath, 'utf8'));
    expect(changed.some((l) => l.line.startsWith('Updated management.secret-key'))).toBe(true);
    expect(compareSync('second-key-value', after.management['secret-key'])).toBe(true);
    expect(compareSync('first-key-value', after.management['secret-key'])).toBe(false);
    expect(after.routing).toEqual({ strategy: 'fill-first' });
  });

  it('drops an inherited MANAGEMENT_PASSWORD in the default mode', async () => {
    const saved = process.env.MANAGEMENT_PASSWORD;
    process.env.MANAGEMENT_PASSWORD = 'inherited-value';
    try {
      const lines: LogLine[] = [];
      const server = await startServer({
        binaryPath: FAKE,
        stateDir: dir,
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

  it('can pass the key through MANAGEMENT_PASSWORD when explicitly requested', async () => {
    const lines: LogLine[] = [];
    const server = await startServer({
      binaryPath: FAKE,
      stateDir: dir,
      management: { key: 'mgmt-secret-value', viaEnvironment: true },
      onLog: (l) => lines.push(l),
    });
    await server.stop();
    expect(lines.some((l) => l.line === 'MANAGEMENT_PASSWORD length 17')).toBe(true);
    expect(server.managementKey).toBe('mgmt-secret-value');
    const written = parseYaml(await readFile(server.configPath, 'utf8'));
    expect(written.management).toBeUndefined();
  });

  it('warns when remote management is exposed on a non-loopback host', async () => {
    const warn = async (options: Pick<StartWithConfigOptions, 'management' | 'host'>): Promise<string[]> => {
      const lines: LogLine[] = [];
      const server = await startServer({ binaryPath: FAKE, host: '0.0.0.0', onLog: (l) => lines.push(l), ...options });
      await server.stop();
      return lines.filter((l) => l.line.includes('reachable from non-loopback')).map((l) => l.line);
    };

    expect(await warn({ management: { key: 'k', allowRemote: true } })).toHaveLength(1);
    expect(await warn({ management: { key: 'k', viaEnvironment: true } })).toHaveLength(1);
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
      startServer({ binaryPath: FAKE, configPath, management: { key: 'env-key', viaEnvironment: true } }),
    );
    expect(error.code).toBe('invalid-options');
    expect(error.message).toMatch(/configPath/);
  });

  it('passes Home options as a flag plus HOME_JWT, keeping the JWT out of argv and logs', async () => {
    const lines: LogLine[] = [];
    const server = await startServer({
      binaryPath: FAKE,
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
    const bogus = join(dir, 'cli-proxy-api');
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
      const server = await startServer({
        binaryPath: FAKE,
        config: { routing: { strategy: 'fill-first' }, access: { 'api-keys': ['model-key'] } },
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
      const runtime = JSON.parse(await readFile(configPath, 'utf8'));
      runtime.routing = { strategy: 'round-robin' };
      await writeFile(configPath, `${JSON.stringify(runtime, null, 2)}\n`);
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
      expect(JSON.parse(await readFile(configPath, 'utf8')).routing).toEqual({ strategy: 'round-robin' });

      const exit = await server.stop();
      expect(await server.exited).toEqual(exit);
      expect(exits).toBe(1);
      expect(existsSync(stateDir)).toBe(false);
    });

    it('shares one operation between concurrent restart calls', async () => {
      const counter = join(dir, 'runs');
      const server = await startServer({ binaryPath: FAKE, env: { FAKE_COUNTER: counter } });
      const first = server.restart();
      const second = server.restart();
      expect(second).toBe(first);
      await first;
      expect(await readFile(counter, 'utf8')).toBe('2');
      await server.stop();
    });

    it('aborts an in-flight restart when stop() is called', async () => {
      const counter = join(dir, 'runs');
      const server = await startServer({
        binaryPath: FAKE,
        env: { FAKE_COUNTER: counter, FAKE_DELAY_AFTER: '1', FAKE_DELAY_MS: '5000' },
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
      const server = await startServer({
        binaryPath: FAKE,
        env: { FAKE_COUNTER: counter, FAKE_DELAY_AFTER: '1', FAKE_DELAY_MS: '1500' },
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
      const server = await startServer({ binaryPath: FAKE });
      const error = await startError(server.restart({ signal: AbortSignal.abort(new Error('nope')) }));
      expect(error.code).toBe('aborted');
      expect(error.cause).toEqual(new Error('nope'));
      expect(existsSync(server.stateDir)).toBe(false);
      await server.stop();
      await expect(server.restart()).rejects.toMatchObject({ code: 'stopped' });
    });

    it('resolves exited once when the restarted process dies on its own', async () => {
      const server = await startServer({ binaryPath: FAKE });
      await server.restart();
      process.kill(server.pid, 'SIGKILL');
      const expected = { code: null, signal: 'SIGKILL' };
      expect(await server.exited).toEqual(expected);
      expect(await server.stop()).toEqual(expected);
      expect(existsSync(server.stateDir)).toBe(false);
    });
  });
});
