// Restart contract tests against a real CLIProxyAPI binary. Each test uses its
// own process so the management-key ban from one test cannot affect another.
import { afterAll, describe, expect, it } from 'vitest';
import { CpaHttpError, createClient } from '../../src/client/index.ts';
import { startServer, type CpaServer } from '../../src/server/index.ts';
import { findBinary } from './helpers.ts';

const binary = findBinary();
const MANAGEMENT_KEY = 'restart-management-key';
const MODEL_KEY = 'restart-model-key';

describe.skipIf(!binary)('restart against real CPA', () => {
  const servers: CpaServer[] = [];

  async function newServer(): Promise<CpaServer> {
    const server = await startServer({
      binaryPath: binary!,
      managementKey: MANAGEMENT_KEY,
      localModel: true,
      config: {
        management: { 'disable-control-panel': true },
        access: { 'api-keys': [MODEL_KEY] },
      },
    });
    servers.push(server);
    return server;
  }

  afterAll(async () => {
    for (const server of servers) await server.stop();
  });

  it('clears a management-key IP ban', async () => {
    const server = await newServer();
    const wrong = createClient({ baseUrl: server.origin, managementKey: 'wrong-key' });
    for (let attempt = 0; attempt < 5; attempt++) {
      const error = (await wrong.plugins.list().catch((e: unknown) => e)) as CpaHttpError;
      expect(error).toBeInstanceOf(CpaHttpError);
      expect(error.status).toBe(401);
    }

    const correct = createClient({ baseUrl: server.origin, managementKey: MANAGEMENT_KEY });
    const banned = (await correct.plugins.list().catch((e: unknown) => e)) as CpaHttpError;
    expect(banned).toBeInstanceOf(CpaHttpError);
    expect(banned.status).toBe(403);
    expect(banned.errorCode).toMatch(/^IP banned due to too many failed attempts\./);

    const origin = server.origin;
    const oldPid = server.pid;
    await server.restart();
    expect(server.origin).toBe(origin);
    expect(server.pid).not.toBe(oldPid);
    await expect(correct.plugins.list()).resolves.toMatchObject({ plugins_enabled: false, plugins: [] });
  });

  it('keeps changes made through the management API across a restart', async () => {
    const server = await newServer();
    const client = createClient({ baseUrl: server.origin, managementKey: MANAGEMENT_KEY });
    const { etag } = await client.config.get();
    await client.config.patch({ routing: { strategy: 'round-robin' } }, { ifMatch: etag! });

    const origin = server.origin;
    const stateDir = server.stateDir;
    const configPath = server.configPath;
    await server.restart();

    expect(server.origin).toBe(origin);
    expect(server.stateDir).toBe(stateDir);
    expect(server.configPath).toBe(configPath);
    expect((await client.config.getPath('routing/strategy')).data).toBe('round-robin');
  });
});
