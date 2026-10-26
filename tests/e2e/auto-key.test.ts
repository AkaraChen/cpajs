// With no management key given, server.client() reaches the real management API.
import { describe, expect, it } from 'vitest';
import { CPA_RELEASE, startServer } from '../../src/server/index.ts';
import { findBinary } from './helpers.ts';

const binary = findBinary();

describe.skipIf(!binary)('generated management key with the real CPA', () => {
  it('serves server.client() without any key from the caller, across restart()', async () => {
    const server = await startServer({ binaryPath: binary!, localModel: true, config: { management: { 'disable-control-panel': true } } });
    try {
      const client = server.client({ timeoutMs: 20_000 });
      expect((await client.server.info()).version).toBe(CPA_RELEASE.version);
      await client.config.set('routing/strategy', 'fill-first');

      await server.restart();
      expect((await client.config.getPath('routing/strategy')).data).toBe('fill-first');
      expect(Array.isArray((await server.client().plugins.list()).plugins)).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
