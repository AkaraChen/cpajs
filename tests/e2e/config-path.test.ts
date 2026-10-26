// configPath mode: the port cpajs probes must be the one CPA actually binds.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../src/server/index.ts';
import { findFreePort } from '../../src/server/readiness.ts';
import { findBinary } from './helpers.ts';

const binary = findBinary();

interface ConfigCase {
  name: string;
  build(port: number, otherPort: number, authDir: string): string;
}

const cases: ConfigCase[] = [
  {
    name: 'v8',
    build: (port, _otherPort, authDir) =>
      ['config-version: 8', 'server:', '  host: 127.0.0.1', `  port: ${port}`, 'oauth:', `  auth-dir: ${authDir}`, ''].join('\n'),
  },
  {
    name: 'legacy',
    build: (port, _otherPort, authDir) => ['host: 127.0.0.1', `port: ${port}`, `auth-dir: ${authDir}`, ''].join('\n'),
  },
  {
    name: 'mixed',
    // The legacy port and host lose because the v8 leaves are present.
    build: (port, otherPort, authDir) =>
      [
        'host: 0.0.0.0',
        `port: ${otherPort}`,
        'tls:',
        '  enable: false',
        'server:',
        '  host: 127.0.0.1',
        `  port: ${port}`,
        '  tls:',
        '    enable: false',
        'oauth:',
        `  auth-dir: ${authDir}`,
        '',
      ].join('\n'),
  },
];

describe.skipIf(!binary)('configPath listener precedence against real CPA', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cpajs-e2e-config-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe.each(cases)('$name config', ({ name, build }) => {
    it('reaches /healthz on the port CPA really binds', async () => {
      const port = await findFreePort('127.0.0.1');
      const otherPort = port === 65_535 ? port - 1 : port + 1;
      const configPath = join(dir, `${name}.yaml`);
      await writeFile(configPath, build(port, otherPort, join(dir, `${name}-auths`)));

      const server = await startServer({ binaryPath: binary!, configPath, localModel: true });
      try {
        expect(server.port).toBe(port);
        expect(server.host).toBe('127.0.0.1');
        const res = await fetch(`${server.origin}/healthz`);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ status: 'ok' });
      } finally {
        await server.stop();
      }

      if (name === 'mixed') {
        const saved = parseYaml(await readFile(configPath, 'utf8')) as Record<string, unknown>;
        expect(saved).not.toHaveProperty('host');
        expect(saved).not.toHaveProperty('port');
        expect(saved.server).toMatchObject({ host: '127.0.0.1', port });
      }
    });
  });
});
