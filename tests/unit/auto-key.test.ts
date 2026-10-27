// When no management key is given, cpajs generates one per start and exposes a
// bound client instead of the key (server.client()).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSync } from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { CpaConfig } from '../../src/client/index.ts';
import { startServer, type CpaServer, type CpaWarning, type StartServerOptions } from '../../src/server/index.ts';
import { internalCommand } from '../../src/server/internal.ts';
import { findFreePort } from '../../src/server/readiness.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-cpa.mjs', import.meta.url));
const startFake = (options: StartServerOptions = {}): Promise<CpaServer> =>
  startServer({ ...options, [internalCommand]: { path: process.execPath, args: [FAKE] } } as unknown as StartServerOptions);

/** The key a server.client() sends, captured from its Authorization header. */
async function sentKey(server: CpaServer): Promise<string> {
  let auth = '';
  const client = server.client({
    fetch: async (req) => {
      auth = req.headers.get('authorization') ?? '';
      return Response.json({ plugins_enabled: false, plugins_dir: '', plugins: [] });
    },
  });
  await client.plugins.list();
  expect(auth).toMatch(/^Bearer /);
  return auth.slice('Bearer '.length);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cpajs-autokey-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const storedHash = async (server: CpaServer): Promise<string> => parseYaml(await readFile(server.configPath, 'utf8')).management['secret-key'];

describe('generated management key', () => {
  it('stores only a bcrypt hash and binds server.client() to the plaintext', async () => {
    const server = await startFake({ stateDir: dir });
    try {
      const key = await sentKey(server);
      expect(key.length).toBeGreaterThanOrEqual(40);
      const text = await readFile(server.configPath, 'utf8');
      expect(text).not.toContain(key);
      const config = parseYaml(text);
      expect(config.management['allow-remote']).toBe(false);
      expect(compareSync(key, config.management['secret-key'])).toBe(true);
      // CPA re-hashes at the stored cost on every management request; keep it cheap.
      expect(config.management['secret-key']).toMatch(/^\$2[aby]\$04\$/);
      expect('managementKey' in server).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('binds the client to the server origin', async () => {
    const server = await startFake();
    try {
      let url = '';
      const fetch = async (req: Request): Promise<Response> => {
        url = req.url;
        return Response.json({ plugins: [] });
      };
      await server.client({ fetch }).plugins.list();
      expect(url.startsWith(`${server.origin}/v8/management/`)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('keeps the key across restart() and generates a new one on the next start', async () => {
    const warnings: CpaWarning[] = [];
    const server = await startFake({ stateDir: dir, onWarning: (w) => warnings.push(w) });
    const key = await sentKey(server);
    await server.restart();
    expect(await sentKey(server)).toBe(key);
    expect(compareSync(key, await storedHash(server))).toBe(true);
    await server.stop();

    const next = await startFake({ stateDir: dir, onWarning: (w) => warnings.push(w) });
    try {
      const nextKey = await sentKey(next);
      expect(nextKey).not.toBe(key);
      expect(compareSync(nextKey, await storedHash(next))).toBe(true);
      // Rotating a generated key on a reused config is routine, not worth a warning.
      expect(warnings.map((w) => w.code)).not.toContain('managementKeyUpdated');
    } finally {
      await next.stop();
    }
  });

  it('disables the control panel by default, unless the config chooses', async () => {
    const panel = async (options: { config?: CpaConfig; management?: { key: string } }) => {
      const server = await startFake({ stateDir: dir, overwriteConfig: true, ...options });
      try {
        return parseYaml(await readFile(server.configPath, 'utf8')).management['disable-control-panel'];
      } finally {
        await server.stop();
      }
    };
    expect(await panel({})).toBe(true);
    expect(await panel({ config: { management: { 'disable-control-panel': false } } })).toBe(false);
    // An explicit key can log in to the panel, so it is left to CPA's default.
    expect(await panel({ management: { key: 'explicit-key-value' } })).toBeUndefined();
  });

  it('uses an explicit key when given', async () => {
    const server = await startFake({ stateDir: dir, management: { key: 'explicit-key-value' } });
    try {
      expect(await sentKey(server)).toBe('explicit-key-value');
    } finally {
      await server.stop();
    }
  });

  it('disables management with management: false', async () => {
    const server = await startFake({ stateDir: dir, management: false });
    try {
      expect(parseYaml(await readFile(server.configPath, 'utf8')).management).toBeUndefined();
      expect(() => server.client()).toThrow(/management: false/);
    } finally {
      await server.stop();
    }
  });

  it('does not generate a key when the secret is the caller’s', async () => {
    const own = await startFake({ stateDir: dir, config: { management: { 'secret-key': 'my-own-secret' } } });
    try {
      expect(await storedHash(own)).toBe('my-own-secret');
      expect(() => own.client()).toThrow(/secret-key/);
    } finally {
      await own.stop();
    }

    const reservation = await findFreePort('127.0.0.1');
    await reservation.release();
    const fileContent = JSON.stringify({ server: { host: '127.0.0.1', port: reservation.port } });
    const configPath = join(dir, 'own.yaml');
    await writeFile(configPath, fileContent);
    const fromFile = await startFake({ configPath });
    try {
      expect(() => fromFile.client()).toThrow(/configPath/);
      // The caller's file is never touched.
      expect(await readFile(configPath, 'utf8')).toBe(fileContent);
    } finally {
      await fromFile.stop();
    }
  });
});
