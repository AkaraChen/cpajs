import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { candidateTargets, resolveBinary } from '../../src/server/binary.ts';
import {
  configSecrets,
  inspectConfigFile,
  readListenSettings,
  readManagedConfig,
  readManagementSettings,
  updateManagedSecret,
  writeManagedConfig,
} from '../../src/server/config.ts';
import { buildArgs } from '../../src/server/args.ts';
import { CpaBinaryError, CpaStartError, startServer } from '../../src/server/index.ts';
import { connectHost, formatOrigin, isLoopbackHost } from '../../src/server/readiness.ts';
import { createRedactor } from '../../src/server/redact.ts';
import { TARGETS } from '../../src/server/targets.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cpajs-unit-'));
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
    // Non-Linux hosts have no libc. The static/portable targets are still eligible.
    expect(candidateTargets({ os: 'freebsd', cpu: 'x64' }).map((t) => t.id)).toEqual(['freebsd-x64']);
    expect(candidateTargets({ os: 'win32', cpu: 'arm64' }).map((t) => t.id)).toEqual(['win32-arm64']);
    expect(candidateTargets({ os: 'openbsd', cpu: 'arm64' }).map((t) => t.id)).toEqual(['openbsd-arm64']);
    // If libc is undetectable on Linux, only the static portable build can be offered.
    expect(candidateTargets({ os: 'linux', cpu: 'x64' }).map((t) => t.id)).toEqual(['linux-x64-musl']);
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
  it('follows upstream v8/legacy presence precedence', () => {
    const cases: { name: string; doc: unknown; expected: { host: string; port: number; tls: boolean } }[] = [
      {
        name: 'v8 only',
        doc: { server: { host: '127.0.0.1', port: 9000, tls: { enable: true } } },
        expected: { host: '127.0.0.1', port: 9000, tls: true },
      },
      {
        name: 'legacy only',
        doc: { host: '0.0.0.0', port: 9001, tls: { enable: true } },
        expected: { host: '0.0.0.0', port: 9001, tls: true },
      },
      {
        name: 'v8 host and port win over legacy values',
        doc: { host: '0.0.0.0', port: 1, server: { host: '127.0.0.1', port: 2 } },
        expected: { host: '127.0.0.1', port: 2, tls: false },
      },
      {
        name: 'v8 explicit zero port wins over legacy',
        doc: { port: 8317, server: { port: 0 } },
        expected: { host: '', port: 0, tls: false },
      },
      {
        name: 'v8 null port wins over legacy and decodes as zero',
        doc: { port: 8317, server: { port: null } },
        expected: { host: '', port: 0, tls: false },
      },
      {
        name: 'v8 null host wins over legacy and decodes as empty',
        doc: { host: '0.0.0.0', server: { host: null } },
        expected: { host: '', port: 0, tls: false },
      },
      {
        name: 'legacy values apply when the v8 leaf is absent',
        doc: { host: '0.0.0.0', port: 8080, server: { tls: {} } },
        expected: { host: '0.0.0.0', port: 8080, tls: false },
      },
      {
        name: 'missing port is zero, not 8317',
        doc: {},
        expected: { host: '', port: 0, tls: false },
      },
      {
        name: 'negative port is preserved for the caller to reject',
        doc: { server: { port: -5 } },
        expected: { host: '', port: -5, tls: false },
      },
      {
        name: 'float port truncates like yaml.v3',
        doc: { server: { port: 9001.9 } },
        expected: { host: '', port: 9001, tls: false },
      },
      {
        name: 'v8 tls enable true wins over legacy false',
        doc: { tls: { enable: false }, server: { tls: { enable: true } } },
        expected: { host: '', port: 0, tls: true },
      },
      {
        name: 'v8 tls enable false wins over legacy true',
        doc: { tls: { enable: true }, server: { tls: { enable: false } } },
        expected: { host: '', port: 0, tls: false },
      },
      {
        name: 'v8 tls enable null wins over legacy true and decodes as false',
        doc: { tls: { enable: true }, server: { tls: { enable: null } } },
        expected: { host: '', port: 0, tls: false },
      },
      {
        name: 'v8 tls without enable inherits legacy enable leaf',
        doc: { tls: { enable: true, cert: 'c', key: 'k' }, server: { tls: { cert: 'other' } } },
        expected: { host: '', port: 0, tls: true },
      },
      {
        name: 'legacy tls null means disabled',
        doc: { tls: null },
        expected: { host: '', port: 0, tls: false },
      },
      {
        name: 'non-numeric port is invalid, not a default',
        doc: { server: { port: '9001' } },
        expected: { host: '', port: Number.NaN, tls: false },
      },
    ];
    for (const testCase of cases) {
      expect(readListenSettings(testCase.doc), testCase.name).toEqual(testCase.expected);
    }
  });

  it('resolves YAML anchors, aliases and merge keys like yaml.v3', async () => {
    const merged = join(dir, 'merged.yaml');
    await writeFile(
      merged,
      [
        'defaults: &defaults',
        '  host: 127.0.0.1',
        '  port: 9100',
        '  tls:',
        '    enable: true',
        'server:',
        '  <<: *defaults',
        '  port: 9101',
        '  tls:',
        '    enable: false',
        '',
      ].join('\n'),
    );
    expect(await inspectConfigFile(merged)).toMatchObject({
      listen: { host: '127.0.0.1', port: 9101, tls: false },
    });

    const aliased = join(dir, 'aliased.yaml');
    await writeFile(aliased, 'listener: &listener\n  host: 0.0.0.0\n  port: 9102\nserver: *listener\n');
    expect(await inspectConfigFile(aliased)).toMatchObject({
      listen: { host: '0.0.0.0', port: 9102, tls: false },
    });

    const rootMerged = join(dir, 'root-merged.yaml');
    await writeFile(rootMerged, 'defaults: &defaults\n  host: 127.0.0.1\n  port: 9103\n<<: *defaults\n');
    expect(await inspectConfigFile(rootMerged)).toMatchObject({
      listen: { host: '127.0.0.1', port: 9103, tls: false },
    });
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

  it('leaves open-ended fields alone by design', () => {
    // A known key name is collected wherever it appears, but arbitrary names inside
    // headers or plugin settings are not guessed at.
    const secrets = configSecrets({
      management: { 'secret-key': 'known' },
      'api-keys': {
        'openai-compatibility': [{ name: 'x', headers: { Authorization: 'Bearer hidden' }, 'api-key': 'upstream-known' }],
      },
      plugins: { configs: { 'my-plugin': { token: 'plugin-hidden', headers: { 'X-Token': 'plugin-hidden' } } } },
    });
    expect(secrets.sort()).toEqual(['known', 'upstream-known']);
  });

  it('writes YAML with listener and auth-dir defaults, then reads it back', async () => {
    expect(await readManagedConfig(dir)).toBeUndefined();
    const prepared = await writeManagedConfig({ access: { 'api-keys': ['k'] } }, dir, { host: '127.0.0.1', port: 1234 });
    const text = await readFile(prepared.configPath, 'utf8');
    expect(text).toContain('config-version: 8');
    expect(text).not.toMatch(/^\{/);
    expect(parseYaml(text)).toEqual({
      access: { 'api-keys': ['k'] },
      server: { host: '127.0.0.1', port: 1234 },
      'config-version': 8,
      oauth: { 'auth-dir': join(dir, 'auths') },
    });
    expect(prepared).toMatchObject({ secrets: ['k'], reused: false });
    expect(await readManagedConfig(dir)).toMatchObject({
      configPath: prepared.configPath,
      listen: { host: '127.0.0.1', port: 1234 },
      secrets: ['k'],
      managed: true,
      reused: true,
    });
    expect(prepared.management).toEqual({ allowRemote: false, hasSecret: false, secretKey: undefined });

    const custom = await writeManagedConfig({ oauth: { 'auth-dir': '/elsewhere' } }, dir, { host: '', port: 1 });
    expect(parseYaml(await readFile(custom.configPath, 'utf8')).oauth).toEqual({ 'auth-dir': '/elsewhere' });
  });

  it('rejects a reused managed config without a fixed port', async () => {
    const file = join(dir, 'config.yaml');
    await writeFile(file, 'server:\n  host: 127.0.0.1\n');
    await expect(readManagedConfig(dir)).rejects.toThrow(/fixed server\.port/);
    await writeFile(file, 'server:\n  port: 0\n');
    await expect(readManagedConfig(dir)).rejects.toThrow(/fixed server\.port/);
  });

  it('merges a management hash without dropping other management settings', async () => {
    const prepared = await writeManagedConfig(
      { management: { 'disable-control-panel': true } },
      dir,
      { host: '127.0.0.1', port: 1234 },
      { secretKeyHash: '$2b$10$hash', allowRemote: true },
    );
    const written = parseYaml(await readFile(prepared.configPath, 'utf8'));
    expect(written.management).toEqual({
      'disable-control-panel': true,
      'secret-key': '$2b$10$hash',
      'allow-remote': true,
    });
    expect(prepared.management).toEqual({ allowRemote: true, hasSecret: true, secretKey: '$2b$10$hash' });
  });

  it('updates only the management fields of a reused config, keeping comments', async () => {
    const file = join(dir, 'config.yaml');
    await writeFile(
      file,
      '# written by CPA\nserver:\n  port: 1234 # keep me\nremote-management:\n  secret-key: legacy\nrouting:\n  strategy: fill-first\n',
    );
    await updateManagedSecret(file, { secretKeyHash: '$2b$10$new', allowRemote: false });
    const text = await readFile(file, 'utf8');
    expect(text).toContain('# written by CPA');
    expect(text).toContain('# keep me');
    expect(parseYaml(text)).toEqual({
      server: { port: 1234 },
      routing: { strategy: 'fill-first' },
      management: { 'secret-key': '$2b$10$new', 'allow-remote': false },
    });
  });

  it('reads management settings from the v8 and legacy sections', () => {
    expect(readManagementSettings({ management: { 'allow-remote': true, 'secret-key': 's' } })).toEqual({
      allowRemote: true,
      hasSecret: true,
      secretKey: 's',
    });
    expect(readManagementSettings({ 'remote-management': { 'allow-remote': true, 'secret-key': ' ' } })).toEqual({
      allowRemote: true,
      hasSecret: false,
      secretKey: undefined,
    });
    // The v8 section wins even when it is empty.
    expect(
      readManagementSettings({ management: {}, 'remote-management': { 'allow-remote': true, 'secret-key': 's' } }),
    ).toEqual({ allowRemote: false, hasSecret: false, secretKey: undefined });
  });

  it('inspects an existing YAML file and rejects missing or invalid ports', async () => {
    const file = join(dir, 'c.yaml');
    await writeFile(file, 'server:\n  host: 127.0.0.1\n  port: 9100\nmanagement:\n  secret-key: s3cret\n');
    expect(await inspectConfigFile(file)).toMatchObject({ listen: { host: '127.0.0.1', port: 9100 }, secrets: ['s3cret'], managed: false });

    for (const yaml of [
      'server:\n  host: 127.0.0.1\n',
      'server:\n  port: 0\n',
      'server:\n  port: null\n',
      'port: -1\n',
      'server:\n  port: 65_536\n',
      "server:\n  port: '9001'\n",
    ]) {
      await writeFile(file, yaml);
      await expect(inspectConfigFile(file), yaml).rejects.toMatchObject({ code: 'invalid-options' });
    }

    await writeFile(file, 'server: null\n');
    await expect(inspectConfigFile(file)).rejects.toThrow(/server.*mapping/);
    await writeFile(file, 'server:\n  tls: null\n');
    await expect(inspectConfigFile(file)).rejects.toThrow(/server\.tls.*mapping/);
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

  it('rejects conflicting management key sources', async () => {
    const invalid = async (options: Parameters<typeof startServer>[0]) => {
      const error = (await startServer(options).catch((e: unknown) => e)) as CpaStartError;
      expect(error).toBeInstanceOf(CpaStartError);
      expect(error.code).toBe('invalid-options');
      return error.message;
    };

    expect(await invalid({ management: { key: 'a' }, managementKey: 'b' })).toMatch(/deprecated alias/);
    expect(await invalid({ management: { key: '  ' } })).toMatch(/must not be empty/);
    expect(await invalid({ management: { key: 'a' }, config: { management: { 'secret-key': 'b' } } })).toMatch(
      /config\.management\["secret-key"\]/,
    );
    // MANAGEMENT_PASSWORD in env is rejected unless viaEnvironment is used, with or without a key.
    expect(await invalid({ env: { MANAGEMENT_PASSWORD: 'b' } })).toMatch(/MANAGEMENT_PASSWORD/);
    expect(await invalid({ management: { key: ' padded ', viaEnvironment: true } })).toMatch(/whitespace/);
    expect(await invalid({ management: { key: 'a' }, env: { MANAGEMENT_PASSWORD: 'b' } })).toMatch(
      /MANAGEMENT_PASSWORD/,
    );
    expect(await invalid({ management: { key: 'a' }, configPath: '/tmp/config.yaml' })).toMatch(
      /must not edit your config file/,
    );
    // The deprecated alias maps to the default mode, which cannot edit configPath.
    expect(await invalid({ managementKey: 'a', configPath: '/tmp/config.yaml' })).toMatch(
      /must not edit your config file/,
    );
    expect(await invalid({ management: { key: 'a'.repeat(73) } })).toMatch(/72 bytes/);
  });
});

describe('CLI arguments', () => {
  it('maps typed options to flags and appends plugin args', () => {
    expect(buildArgs({})).toEqual([]);
    expect(buildArgs({ localModel: true, home: { jwt: 'j', disableClusterDiscovery: true }, args: ['-plugin-x', 'v'] })).toEqual([
      '-local-model',
      '-home-disable-cluster-discovery',
      '-plugin-x',
      'v',
    ]);
    // The JWT itself travels through HOME_JWT, never argv.
    expect(buildArgs({ home: { jwt: 'secret' } })).toEqual([]);
  });

  it('rejects one-shot commands and flags that have typed options', () => {
    for (const arg of ['-codex-login', '--tui', '-vertex-import=/k.json', '-discover']) {
      expect(() => buildArgs({ args: [arg] })).toThrow(/one-shot command/);
    }
    expect(() => buildArgs({ args: ['-local-model'] })).toThrow(/localModel option/);
    expect(() => buildArgs({ args: ['--config', 'x.yaml'] })).toThrow(/configPath/);
    expect(() => buildArgs({ args: ['-home-jwt=x'] })).toThrow(/home\.jwt/);
    expect(() => buildArgs({ args: ['-password', 'x'] })).toThrow(/management\.key/);
    // Values are not mistaken for flags.
    expect(buildArgs({ args: ['-plugin-path', 'codex-login'] })).toEqual(['-plugin-path', 'codex-login']);
  });

  it('rejects an empty Home JWT', async () => {
    await expect(startServer({ home: { jwt: '' } })).rejects.toMatchObject({ code: 'invalid-options' });
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

  it('detects loopback bind hosts', () => {
    for (const host of ['127.0.0.1', '127.10.20.30', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['', '0.0.0.0', '::', '[::]', '192.168.1.10', 'cpa.example.com']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});
