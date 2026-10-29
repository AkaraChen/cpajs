// Needs CPA_BINARY (a real CLIProxyAPI). Uses fabricated JWTs; nothing talks to OpenAI.
import { startServer } from '@cpajs/cpa/server';
import { describe, expect, it } from 'vitest';
import { parseIdToken, type CodexTokens } from '../../src/index.ts';
import { uploadToCpa } from '../../src/cpa.ts';
import { idToken } from '../helpers.ts';

const binary = process.env.CPA_BINARY;

describe.skipIf(!binary)('uploading a built codex auth file to a real CPA', () => {
  it('lists it as provider codex with the email and plan from the file', async () => {
    const server = await startServer({ binaryPath: binary!, localModel: true, config: { management: { 'disable-control-panel': true } } });
    try {
      const client = server.client({ timeoutMs: 20_000 });
      const id = idToken({ email: 'e2e@example.com', plan: 'team' });
      const tokens: CodexTokens = {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        idToken: id,
        expiresAt: new Date(Date.now() + 10 * 24 * 3600_000).toISOString(),
        expiresIn: 10 * 24 * 3600,
        claims: parseIdToken(id),
      };
      const { name } = await uploadToCpa(client, tokens);

      const entry = await client.credentials.get(name);
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({ provider: 'codex', email: 'e2e@example.com' });
      expect(JSON.stringify(entry)).toContain('team');

      // CPA accepts ".." inside a flat file name, so an email with consecutive dots must upload too.
      const dotted = idToken({ email: 'first..last@example.com', plan: 'plus' });
      const uploaded = await uploadToCpa(client, { ...tokens, idToken: dotted, claims: parseIdToken(dotted) });
      expect(uploaded.name).toContain('first..last@example.com');
      expect(await client.credentials.get(uploaded.name)).toMatchObject({ provider: 'codex', email: 'first..last@example.com' });
    } finally {
      await server.stop();
    }
  });
});
