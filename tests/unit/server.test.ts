import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { candidateTargets, resolveBinary } from '../../src/server/binary.ts';
import { configSecrets, inspectConfigFile, readListenSettings, writeManagedConfig } from '../../src/server/config.ts';
import { CpaBinaryError, CpaStartError, startServer } from '../../src/server/index.ts';
import { connectHost, formatOrigin } from '../../src/server/readiness.ts';
import { createRedactor } from '../../src/server/redact.ts';
import { TARGETS } from '../../src/server/targets.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cpa-js-unit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('targets', () => {
  it('has unique ids and at most one target per os/cpu/libc', () => {
    expect(new Set(TARGETS.map((t) => t.id)).size).toBe(TARGETS.length);
    const keys = TARGETS.map((t) => `${t.os}/${t.cpu}/${t.libc ?? '*'}`);
    expect(new Set(keys).size).toBe(keys.length);
    // A static (libc-less) target must not coexist with libc-specific ones on the same os/cpu.
    for (const t of TARGETS.filter((x) => x.libc === undefined)) {
      expect(TARGETS.some((o) => o !== t && o.os === t.os && o.cpu === t.cpu)).toBe(false);
    }
  });

  it('prefers the matching libc and falls back to the static portable build', () => {
    expect(candidateTargets({ os: 'linux', cpu: 'x64', libc: 'glibc' }).map((t) => t.id)).toEqual(['linux-x64-gnu', 'linux-x64-musl']);
    // The glibc build is dynamically linked and never offered on musl.
    expect(candidateTargets({ os: 'linux', cpu: 'arm64', libc: 'musl' }).map((t) => t.id)).toEqual(['linux-arm64-musl']);
    expect(candidateTargets({ os: 'linux', cpu: 'arm', libc: 'musl' }).map((t) => t.id)).toEqual(['linux-arm']);
    expect(candidateTargets({ os: 'darwin', cpu: 'arm64' }).map((t) => t.id)).toEqual(['darwin-arm64']);
    expect(candidateTargets({ os: 'sunos', cpu: 'x64' })).toEqual([]);
  });
});

describe('resolveBinary', () => {
  it('reports unsupported platforms and missing packages with codes', () => {
    const unsupported = (() => {
      try {
        resolveBinary({ platform: { os: 'aix', cpu: 'ppc64' } });
      } catch (e) {
        return e;
      }
    })() as CpaBinaryError;
    expect(unsupported).toBeInstanceOf(CpaBinaryError);
    expect(unsupported.code).toBe('unsupported-platform');

    const missing = (() => {
      try {
        resolveBinary({ platform: { os: 'freebsd', cpu: 'arm64' } });
      } catch (e) {
        return e;
      }
    })() as CpaBinaryError;
    expect(missing.code).toBe('package-not-installed');
    expect(missing.message).toContain('@cpajs/freebsd-arm64');
  });

  it('validates binaryPath', async () => {
    expect(() => resolveBinary({ binaryPath: join(dir, 'nope') })).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(() => resolveBinary({ binaryPath: dir })).toThrow(expect.objectContaining({ code: 'missing' }));
    const file = join(dir, 'cli-proxy-api');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o644);
    // A missing executable bit is restored once.
    expect(resolveBinary({ binaryPath: file }).path).toBe(file);
  });
});

describe('config handling', () => {
  it('reads v8 listener keys, then legacy keys, then defaults', () => {
    expect(readListenSettings({ server: { host: '127.0.0.1', port: 9000, tls: { enable: true } } })).toEqual({ host: '127.0.0.1', port: 9000, tls: true });
    expect(readListenSettings({ host: '0.0.0.0', port: '9001' })).toEqual({ host: '0.0.0.0', port: 9001, tls: false });
    expect(readListenSettings({ port: 1, server: { port: 2 } }).port).toBe(2);
    expect(readListenSettings({}).port).toBe(8317);
    expect(readListenSettings({ server: { port: -5 } }).port).toBe(8317);
    expect(readListenSettings({ server: { port: 0 } }).port).toBe(0);
  });

  it('collects secrets from the whole document', () => {
    const secrets = configSecrets({
      management: { 'secret-key': 'mgmt' },
      access: { 'api-keys': ['k1', 'k2'] },
      server: { 'github-token': 'ghp' },
      'api-keys': { codex: [{ keys: [{ 'api-key': 'sk-upstream' }] }] },
      'remote-management': { 'secret-key': 'legacy' },
    });
    expect(secrets.sort()).toEqual(['ghp', 'k1', 'k2', 'legacy', 'mgmt', 'sk-upstream']);
  });

  it('writes the managed config with listener and auth-dir defaults', async () => {
    const prepared = await writeManagedConfig({ access: { 'api-keys': ['k'] } }, dir, { host: '127.0.0.1', port: 1234 });
    const written = JSON.parse(await readFile(prepared.configPath, 'utf8'));
    expect(written).toEqual({
      access: { 'api-keys': ['k'] },
      server: { host: '127.0.0.1', port: 1234 },
      'config-version': 8,
      oauth: { 'auth-dir': join(dir, 'auths') },
    });
    expect(prepared.secrets).toEqual(['k']);

    const custom = await writeManagedConfig({ oauth: { 'auth-dir': '/elsewhere' } }, dir, { host: '', port: 1 });
    expect(JSON.parse(await readFile(custom.configPath, 'utf8')).oauth).toEqual({ 'auth-dir': '/elsewhere' });
  });

  it('inspects an existing YAML file and rejects port 0', async () => {
    const file = join(dir, 'c.yaml');
    await writeFile(file, 'server:\n  host: 127.0.0.1\n  port: 9100\nmanagement:\n  secret-key: s3cret\n');
    expect(await inspectConfigFile(file)).toMatchObject({ listen: { host: '127.0.0.1', port: 9100 }, secrets: ['s3cret'], managed: false });
    await writeFile(file, 'server:\n  port: 0\n');
    await expect(inspectConfigFile(file)).rejects.toThrow(/port 0/);
    await expect(inspectConfigFile(join(dir, 'missing.yaml'))).rejects.toBeInstanceOf(CpaStartError);
  });
});

describe('startServer option validation', () => {
  it('rejects conflicting options before doing anything', async () => {
    await expect(startServer({ config: {}, configPath: 'x' } as never)).rejects.toMatchObject({ code: 'invalid-options' });
    await expect(startServer({ configPath: 'x', port: 1 } as never)).rejects.toMatchObject({ code: 'invalid-options' });
    await expect(startServer({ port: 70_000 })).rejects.toMatchObject({ code: 'invalid-options' });
    await expect(startServer({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('helpers', () => {
  it('redacts every secret occurrence, longest first', () => {
    const redact = createRedactor(['abcd', 'abcdef', undefined, 'x']);
    expect(redact('key=abcdef other=abcd short=x')).toBe('key=[REDACTED] other=[REDACTED] short=x');
  });

  it('formats origins', () => {
    expect(connectHost('')).toBe('127.0.0.1');
    expect(connectHost('::')).toBe('::1');
    expect(formatOrigin('http', '::1', 80)).toBe('http://[::1]:80');
    expect(formatOrigin('https', 'localhost', 8443)).toBe('https://localhost:8443');
  });
});
