// Contract tests: the typed client against a real CLIProxyAPI with a fake upstream.
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CpaHttpError, createClient, type CpaClient } from '../../src/client/index.ts';
import { CPA_RELEASE, startServer, type CpaServer } from '../../src/server/index.ts';
import { eventually, findBinary, startFakeUpstream, type FakeUpstream } from './helpers.ts';

const binary = findBinary();
const MANAGEMENT_KEY = 'e2e-management-key';
const MODEL_KEY = 'e2e-model-key';

describe.skipIf(!binary)('client contract against real CPA', () => {
  let upstream: FakeUpstream;
  let server: CpaServer;
  let client: CpaClient;

  beforeAll(async () => {
    upstream = await startFakeUpstream();
    server = await startServer({
      binaryPath: binary!,
      managementKey: MANAGEMENT_KEY,
      args: ['-local-model'],
      config: {
        management: { 'disable-control-panel': true },
        access: { 'api-keys': [MODEL_KEY] },
        observability: { logs: { 'logging-to-file': true }, usage: { 'usage-statistics-enabled': true } },
        'api-keys': {
          'openai-compatibility': [
            {
              name: 'fake',
              'base-url': `${upstream.url}/v1`,
              keys: [{ 'api-key': 'upstream-key' }],
              models: [{ name: 'fake-model', alias: 'fake-model' }],
            },
          ],
        },
      },
    });
    client = createClient({ baseUrl: server.origin, managementKey: MANAGEMENT_KEY, timeoutMs: 20_000 });
  });

  afterAll(async () => {
    await server?.stop();
    await upstream?.close();
  });

  describe('server', () => {
    it('reports health and version', async () => {
      await expect(client.server.health()).resolves.toEqual({ status: 'ok' });
      const info = await client.server.info();
      expect(info.version).toBe(CPA_RELEASE.version);
      expect(info.commit).toBe(CPA_RELEASE.commit.slice(0, 7));
    });

    it('rejects a wrong management key with 401', async () => {
      // One failure only: five failures ban the IP for 30 minutes.
      const wrong = createClient({ baseUrl: server.origin, managementKey: 'wrong' });
      const error = (await wrong.plugins.list().catch((e: unknown) => e)) as CpaHttpError;
      expect(error).toBeInstanceOf(CpaHttpError);
      expect(error.status).toBe(401);
      expect(error.errorCode).toBe('invalid management key');
    });
  });

  describe('config', () => {
    it('reads the document with an ETag', async () => {
      const { data, etag } = await client.config.get();
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(data['config-version']).toBe(8);
      expect(data.server).toMatchObject({ host: '127.0.0.1', port: server.port });
      expect(data['api-keys']?.['openai-compatibility']?.[0]?.keys?.[0]?.auth_index).toMatch(/^[0-9a-f]+$/);
    });

    it('patches, reads paths, sets and deletes nodes', async () => {
      const before = await client.config.get();
      const patched = await client.config.patch({ routing: { strategy: 'fill-first' } }, { ifMatch: before.etag! });
      expect(patched.data).toEqual({ status: 'ok', 'config-version': 8 });
      expect(patched.etag).not.toBe(before.etag);

      expect((await client.config.getPath('routing/strategy')).data).toBe('fill-first');
      await client.config.set(['routing', 'retry', 'request-retry'], 2);
      expect((await client.config.getPath<number>(['routing', 'retry', 'request-retry'])).data).toBe(2);
      await client.config.patchPath('routing/retry', { 'max-retry-credentials': 1 });
      expect((await client.config.getPath('routing/retry')).data).toEqual({ 'request-retry': 2, 'max-retry-credentials': 1 });
      await client.config.delete('routing/retry');
      const missing = (await client.config.getPath('routing/retry').catch((e: unknown) => e)) as CpaHttpError;
      expect(missing.status).toBe(404);
      expect(missing.errorCode).toBe('not_found');
    });

    it('fails a stale If-Match with 412', async () => {
      const { etag } = await client.config.get();
      await client.config.set('routing/strategy', 'round-robin');
      const error = (await client.config.set('routing/strategy', 'fill-first', { ifMatch: etag! }).catch((e: unknown) => e)) as CpaHttpError;
      expect(error.status).toBe(412);
      expect(error.errorCode).toBe('precondition_failed');
    });

    it('rejects invalid documents with the native error', async () => {
      const error = (await client.config.patch({ bogus: 1 } as never).catch((e: unknown) => e)) as CpaHttpError;
      expect(error.status).toBe(400);
      expect(error.errorCode).toBe('invalid_config');
      expect(error.errorMessage).toContain('bogus');
    });

    it('round-trips YAML losslessly', async () => {
      const { data: yaml } = await client.config.getYaml();
      expect(yaml).toContain('config-version: 8');
      const commented = `# kept by cpa-js e2e\n${yaml}`;
      await client.config.replaceYaml(commented);
      expect((await client.config.getYaml()).data).toContain('# kept by cpa-js e2e');
    });

    it('hot-reloads a new model API key', async () => {
      const ok = async (key: string) =>
        (await fetch(`${server.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } })).status === 200;
      expect(await ok('hot-key')).toBe(false);
      await client.config.set('access/api-keys', [MODEL_KEY, 'hot-key']);
      await eventually(() => ok('hot-key'));
    });
  });

  describe('model API through the fake upstream', () => {
    it('proxies non-streaming chat completions', async () => {
      const res = await fetch(`${server.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${MODEL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0]!.message.content).toBe('Hello world');
      const seen = upstream.requests.find((r) => r.path === '/v1/chat/completions');
      expect(seen?.headers.authorization).toBe('Bearer upstream-key');
    });

    it('streams chat completions as SSE', async () => {
      const res = await fetch(`${server.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${MODEL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      const content = text
        .split('\n')
        .filter((l) => l.startsWith('data: {'))
        .map((l) => (JSON.parse(l.slice(6)) as { choices: { delta: { content?: string } }[] }).choices[0]?.delta.content ?? '')
        .join('');
      expect(content).toBe('Hello world');
      expect(text).toContain('[DONE]');
    });
  });

  describe('credentials', () => {
    const file = { name: 'e2e-claude.json', content: { type: 'claude', email: 'e2e@example.com', access_token: 'tok-e2e-secret' } };

    it('uploads, lists, edits, downloads and deletes a credential', async () => {
      await expect(client.credentials.upload(file)).resolves.toEqual({ status: 'ok' });
      const entry = await client.credentials.get(file.name);
      expect(entry).toMatchObject({ name: file.name, provider: 'claude', email: 'e2e@example.com', disabled: false, source: 'file' });
      expect(entry!.recent_requests).toHaveLength(20);

      await expect(client.credentials.patchFields({ name: file.name, priority: 7, note: 'from e2e' })).resolves.toEqual({ status: 'ok' });
      await expect(client.credentials.setStatus({ name: file.name, disabled: true })).resolves.toEqual({ status: 'ok', disabled: true });
      const edited = await client.credentials.get(file.name);
      expect(edited).toMatchObject({ priority: 7, note: 'from e2e', disabled: true, status: 'disabled' });

      const downloaded = JSON.parse(await (await client.credentials.download(file.name)).text()) as Record<string, unknown>;
      expect(downloaded).toMatchObject({ type: 'claude', email: 'e2e@example.com', priority: 7 });

      const models = await client.credentials.models(file.name);
      expect(Array.isArray(models.models)).toBe(true);

      const page = await client.credentials.list({ page: 1, page_size: 1 });
      expect(page).toMatchObject({ page: 1, page_size: 1 });
      expect(typeof page.has_more).toBe('boolean');

      await expect(client.credentials.delete(file.name)).resolves.toEqual({ status: 'ok' });
      expect(await client.credentials.get(file.name)).toBeUndefined();
    });

    it('reports partial multipart uploads as 207 results', async () => {
      const result = await client.credentials.uploadMany([
        { name: 'e2e-a.json', content: { type: 'codex' } },
        { name: 'e2e-b.txt', content: '{}' },
      ]);
      expect(result).toMatchObject({ status: 'partial', uploaded: 1, files: ['e2e-a.json'] });
      const deleted = await client.credentials.delete(['e2e-a.json', 'e2e-missing.json']);
      expect(deleted).toMatchObject({ status: 'partial', deleted: 1 });
    });

    it('surfaces native errors', async () => {
      const error = (await client.credentials.download('nope.json').catch((e: unknown) => e)) as CpaHttpError;
      expect(error.status).toBe(404);
      expect(error.errorCode).toBe('file not found');
    });
  });

  describe('oauth', () => {
    it('starts, polls and cancels a login session without contacting the provider', async () => {
      const started = await client.oauth.start({ provider: 'claude' });
      expect(started.url).toMatch(/^https:\/\//);
      expect(started.state).toMatch(/^[0-9a-f]{32}$/);
      await expect(client.oauth.status(started.state)).resolves.toEqual({ status: 'wait' });
      await expect(client.oauth.cancel(started.state)).resolves.toEqual({ status: 'ok', cancelled: true });
      await expect(client.oauth.status(started.state)).resolves.toEqual({ status: 'error', error: 'unknown or expired state' });
    });

    it('fails a session through the callback route', async () => {
      const started = await client.oauth.start({ provider: 'codex' });
      await expect(client.oauth.callback({ state: started.state, error: 'access_denied' })).resolves.toEqual({ status: 'ok' });
      const done = await client.oauth.waitForCompletion(started.state, { intervalMs: 200, timeoutMs: 5_000 });
      expect(done.status).toBe('error');
    });

    it('rejects unknown providers and states', async () => {
      const provider = (await client.oauth.start({ provider: 'nope' }).catch((e: unknown) => e)) as CpaHttpError;
      expect(provider.status).toBe(404);
      expect(provider.errorCode).toBe('provider_not_found');
      const state = (await client.oauth.callback({ state: 'unknown-state', code: 'x' }).catch((e: unknown) => e)) as CpaHttpError;
      expect(state.status).toBe(404);
      expect(state.data).toEqual({ status: 'error', error: 'unknown or expired state' });
    });
  });

  describe('observability, routing, requests, plugins', () => {
    it('reads logs with a cursor and clears them', async () => {
      await eventually(async () => (await client.logs.get({ limit: 5 })).lines.length > 0);
      const first = await client.logs.get({ limit: 5 });
      expect(first['next-cursor']).not.toBe('');
      const next = await client.logs.get({ cursor: first['next-cursor'], limit: 5 });
      expect(Array.isArray(next.lines)).toBe(true);
      const reset = await client.logs.get({ cursor: 'garbage', limit: 1 });
      expect(reset['cursor-reset']).toBe(true);
      await expect(client.logs.clear()).resolves.toMatchObject({ success: true });
      await expect(client.logs.listErrorLogs()).resolves.toEqual({ files: [] });
    });

    it('reads usage', async () => {
      await expect(client.usage.apiKeys()).resolves.toBeTypeOf('object');
      const records = await client.usage.popQueue(100);
      expect(Array.isArray(records)).toBe(true);
    });

    it('serves model definitions and cooldown errors', async () => {
      const defs = await client.routing.modelDefinitions('claude');
      expect(defs.channel).toBe('claude');
      expect(defs.models.length).toBeGreaterThan(0);
      const error = (await client.routing.resetCooldown('does-not-exist').catch((e: unknown) => e)) as CpaHttpError;
      expect(error.status).toBe(404);
    });

    it('makes server-side API calls', async () => {
      const res = await client.requests.apiCall({ method: 'post', url: `${upstream.url}/echo`, header: { Authorization: 'Bearer abc' }, data: '{"x":1}' });
      expect(res.status_code).toBe(201);
      expect(res.header['X-Echo']).toEqual(['yes']);
      expect(JSON.parse(res.body)).toEqual({ method: 'POST', auth: 'Bearer abc', body: '{"x":1}' });
    });

    it('lists plugins', async () => {
      const list = await client.plugins.list();
      expect(list).toMatchObject({ plugins_enabled: false, plugins: [] });
      const error = (await client.plugins.delete('not-installed').catch((e: unknown) => e)) as CpaHttpError;
      expect(error.status).toBe(404);
      expect(error.errorCode).toBe('plugin_not_found');
    });
  });
});

describe.skipIf(!binary)('server with an existing config file', () => {
  it('hands the file to CPA, which persists a hashed secret', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { findFreePort } = await import('../../src/server/readiness.ts');
    const dir = await mkdtemp(join(tmpdir(), 'cpa-js-e2e-'));
    try {
      const port = await findFreePort('127.0.0.1');
      const configPath = join(dir, 'config.yaml');
      await writeFile(
        configPath,
        `config-version: 8\nserver:\n  host: 127.0.0.1\n  port: ${port}\nmanagement:\n  secret-key: file-secret\n  disable-control-panel: true\noauth:\n  auth-dir: ${join(dir, 'auths')}\n`,
      );
      const lines: string[] = [];
      const server = await startServer({ binaryPath: binary!, configPath, args: ['-local-model'], onLog: (l) => lines.push(l.line) });
      try {
        expect(server.port).toBe(port);
        expect(server.configPath).toBe(configPath);
        const client = createClient({ baseUrl: server.origin, managementKey: 'file-secret' });
        await expect(client.server.info()).resolves.toMatchObject({ version: CPA_RELEASE.version });
        expect(await readFile(configPath, 'utf8')).toMatch(/secret-key: \$2[aby]\$/);
        expect(lines.join('\n')).not.toContain('file-secret');
      } finally {
        await server.stop();
      }
      expect((await import('node:fs')).existsSync(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
