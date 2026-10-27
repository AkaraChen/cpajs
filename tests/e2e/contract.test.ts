// Contract tests: the typed client against a real CLIProxyAPI with a fake upstream.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { compareSync } from 'bcryptjs';
import { parse, stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CpaCredentialNotFoundError,
  CpaCredentialTokenError,
  CpaHttpError,
  CpaReconcileError,
  CpaUpstreamError,
  createClient,
  type CpaClient,
} from '../../src/client/index.ts';
import { CPA_RELEASE, startServer, type CpaServer } from '../../src/server/index.ts';
import { findFreePort } from '../../src/server/readiness.ts';
import { eventually, findBinary, startFakeUpstream, type FakeUpstream } from './helpers.ts';

const binary = findBinary();
const MANAGEMENT_KEY = 'e2e-management-key';
const MODEL_KEY = 'e2e-model-key';

/** A single-file, uncompressed ZIP archive, enough for a plugin store artifact. */
function storedZip(name: string, data: Buffer): Buffer {
  const nameData = Buffer.from(name);
  const checksum = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameData.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameData.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + nameData.length + data.length, 16);
  return Buffer.concat([local, nameData, data, central, nameData, end]);
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe.skipIf(!binary)('client contract against real CPA', () => {
  let upstream: FakeUpstream;
  let server: CpaServer;
  let client: CpaClient;

  beforeAll(async () => {
    upstream = await startFakeUpstream();
    server = await startServer({
      binaryPath: binary!,
      management: { key: MANAGEMENT_KEY },
      localModel: true,
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
      // The gnu matrix entry is the plugin-enabled build; the header value is still a boolean.
      expect(info.supportPlugin).toBeTypeOf('boolean');
    });

    it('stores a bcrypt hash and leaves remote management disabled', async () => {
      const written = parse(await readFile(server.configPath, 'utf8')) as {
        management: Record<string, unknown>;
      };
      expect(written.management['secret-key']).toMatch(/^\$2[aby]\$10\$/);
      expect(written.management['secret-key']).not.toContain(MANAGEMENT_KEY);
      expect(compareSync(MANAGEMENT_KEY, written.management['secret-key'] as string)).toBe(true);
      expect(written.management['allow-remote']).toBe(false);
      expect('managementKey' in server).toBe(false);
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

    it('updates a node with If-Match and reconciles changed sections wholesale', async () => {
      const apiKeys = await client.config.getPath('api-keys');
      expect(JSON.stringify(apiKeys.data)).toContain('auth_index');

      // Writing the read value back succeeds only because update strips auth_index.
      const updated = await client.config.update('api-keys', (current) => current);
      expect(updated.written).toBe(true);
      expect(updated.etag).toMatch(/^"[0-9a-f]{64}"$/);

      const current = await client.config.get();
      await expect(client.config.reconcile(current.data)).resolves.toEqual({ written: false, changed: [], etag: current.etag });

      const changed = await client.config.reconcile({ routing: { strategy: 'fill-first', 'session-affinity-ttl': '1h' } });
      expect(changed.written).toBe(true);
      expect(changed.changed).toEqual(['routing']);
      expect((await client.config.getPath('routing/session-affinity-ttl')).data).toBe('1h');

      // Sections are replaced wholesale: dropping the key removes it, and the next run converges.
      const removed = await client.config.reconcile({ routing: { strategy: 'fill-first' } });
      expect(removed.changed).toEqual(['routing']);
      await expect(client.config.getPath('routing/session-affinity-ttl')).rejects.toMatchObject({ status: 404 });
      await expect(client.config.reconcile({ routing: { strategy: 'fill-first' } })).resolves.toMatchObject({
        written: false,
        changed: [],
      });
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
      const commented = `# kept by cpajs e2e\n${yaml}`;
      await client.config.replaceYaml(commented);
      expect((await client.config.getYaml()).data).toContain('# kept by cpajs e2e');
    });

    it('hot-reloads a new model API key', async () => {
      const ok = async (key: string) =>
        (await fetch(`${server.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } })).status === 200;
      expect(await ok('hot-key')).toBe(false);
      await client.config.set('access/api-keys', [MODEL_KEY, 'hot-key']);
      await eventually(() => ok('hot-key'));
    });

    it('changes the ETag when the watcher hashes a plaintext secret', async () => {
      const before = await client.config.getYaml();
      const doc = parse(before.data) as { management?: Record<string, unknown> };
      // Write the current key in plaintext: the management key lives as a hash in this
      // config, so a different value would lock every later test out.
      doc.management = { ...(doc.management ?? {}), 'secret-key': MANAGEMENT_KEY };
      const written = await client.config.replaceYaml(stringify(doc));
      expect(written.etag).toBeDefined();

      const deadline = Date.now() + 15_000;
      // CPA rewrites the file non-atomically (os.WriteFile truncates first), so a read
      // that lands mid-rewrite answers 500 "empty config". Retry only that error.
      const read = async (): Promise<Awaited<ReturnType<typeof client.config.getYaml>>> => {
        while (true) {
          try {
            return await client.config.getYaml();
          } catch (error) {
            const transient =
              error instanceof CpaHttpError && error.status === 500 && error.errorCode === 'invalid_config' && error.errorMessage === 'empty config';
            if (!transient || Date.now() >= deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      };
      let current = await read();
      while (Date.now() < deadline && !/secret-key: \$2[aby]\$/.test(current.data)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        current = await read();
      }
      expect(current.data).not.toContain(MANAGEMENT_KEY);
      expect(current.data).toMatch(/secret-key: \$2[aby]\$/);
      expect(current.etag).toBeDefined();
      expect(current.etag).not.toBe(written.etag);
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

    it('reports an unresolved selector with CpaCredentialNotFoundError', async () => {
      const missing = 'ffffffffffffffff';
      for (const run of [
        () => client.credentials.modelsFor({ auth_index: missing }),
        () => client.credentials.setStatus({ auth_index: missing, disabled: true }),
        () => client.credentials.delete({ auth_index: missing }),
      ]) {
        const error = await run().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CpaCredentialNotFoundError);
        expect(error).toMatchObject({ selector: { auth_index: missing } });
      }

      const byName = await client.credentials.modelsFor({ name: 'e2e-missing.json' }).catch((e: unknown) => e);
      expect(byName).toBeInstanceOf(CpaCredentialNotFoundError);
      expect(byName).toMatchObject({ selector: { name: 'e2e-missing.json' } });
    });

    it('lists files and config keys, and resolves models for both', async () => {
      await client.credentials.upload({ name: 'e2e-list-all.json', content: { type: 'claude', email: 'list-all@example.com', api_key: 'sk-list' } });
      try {
        const entries = await client.credentials.listAll();
        const file = entries.find((entry) => entry.source === 'file' && entry.name === 'e2e-list-all.json');
        expect(file).toMatchObject({ source: 'file', provider: 'claude', disabled: false });
        expect(file).not.toHaveProperty('apiKey');
        expect(file!.auth_index).not.toBe('');

        const config = entries.find((entry) => entry.source === 'config' && entry.provider === 'fake');
        expect(config).toMatchObject({ source: 'config', label: 'fake', disabled: false, apiKey: 'upstream-key' });
        expect(config!.auth_index).not.toBe('');

        await expect(client.credentials.modelsFor({ name: 'e2e-list-all.json' })).resolves.toBeInstanceOf(Array);
        await expect(client.credentials.modelsFor({ auth_index: config!.auth_index })).resolves.toContainEqual(
          expect.objectContaining({ id: 'fake-model' }),
        );
        await expect(client.credentials.modelsFor({ auth_index: config!.auth_index }, { details: true })).resolves.toContainEqual(
          expect.objectContaining({ id: 'fake-model' }),
        );
        await expect(client.credentials.modelsFor(file!)).resolves.toBeInstanceOf(Array);
        await expect(client.credentials.modelsFor(config!)).resolves.toContainEqual(expect.objectContaining({ id: 'fake-model' }));
      } finally {
        await client.credentials.delete('e2e-list-all.json').catch(() => {});
      }
    });

    it('disables, enables and deletes a config key by auth_index', async () => {
      const name = 'e2e-config-status';
      const model = 'e2e-config-model';
      const group = {
        name,
        'base-url': `${upstream.url}/v1`,
        models: [{ name: model, alias: model }],
        keys: [{ 'api-key': 'e2e-config-key' }],
      };
      const modelIds = async (): Promise<string[]> => {
        const res = await fetch(`${server.baseUrl}/models`, { headers: { Authorization: `Bearer ${MODEL_KEY}` } });
        expect(res.status).toBe(200);
        return ((await res.json()) as { data: { id: string }[] }).data.map((item) => item.id);
      };
      const findEntry = async () =>
        (await client.credentials.listAll()).find(
          (entry) => entry.source === 'config' && entry.provider === 'claude' && entry.label === name,
        );
      const removeGroup = async () => {
        await client.config
          .update('api-keys', (current) => {
            const claude = current?.claude;
            if (!Array.isArray(claude)) return current;
            return { ...current, claude: claude.filter((item) => item.name !== name) };
          })
          .catch(() => {});
      };

      try {
        await client.config.update('api-keys', (current) => ({
          ...(current ?? {}),
          claude: [...(current?.claude ?? []), group],
        }));
        await eventually(async () => (await modelIds()).includes(model));
        await eventually(async () => (await findEntry()) !== undefined);

        const added = await findEntry();
        expect(added).toMatchObject({ source: 'config', provider: 'claude', disabled: false });
        const authIndex = added!.auth_index;
        expect(authIndex).not.toBe('');

        await expect(client.credentials.setStatus({ auth_index: authIndex, disabled: true })).resolves.toMatchObject({
          status: 'ok',
          disabled: true,
          via: 'config:excluded-models',
        });
        await eventually(async () => {
          const entry = (await client.credentials.listAll()).find((item) => item.source === 'config' && item.auth_index === authIndex);
          return entry?.disabled === true;
        });
        await eventually(async () => !(await modelIds()).includes(model));

        await expect(client.credentials.setStatus({ auth_index: authIndex, disabled: false })).resolves.toMatchObject({
          status: 'ok',
          disabled: false,
        });
        await eventually(async () => {
          const entry = (await client.credentials.listAll()).find((item) => item.source === 'config' && item.auth_index === authIndex);
          return entry?.disabled === false;
        });
        await eventually(async () => (await modelIds()).includes(model));

        await expect(client.credentials.delete({ auth_index: authIndex })).resolves.toEqual({ status: 'ok' });
        await eventually(
          async () =>
            !(await client.credentials.listAll()).some((item) => item.source === 'config' && item.auth_index === authIndex),
        );
        await eventually(async () => !(await modelIds()).includes(model));
      } finally {
        await removeGroup();
      }
    });

    it('refreshes an API-key credential and reports a missing file', async () => {
      // A refresh token would call the real provider. An API key has nothing to rotate,
      // so the executor returns the credential unchanged and 200 proves the response shape.
      await expect(
        client.credentials.upload({ name: 'e2e-refresh.json', content: { type: 'claude', email: 'refresh@example.com', api_key: 'sk-refresh' } }),
      ).resolves.toEqual({ status: 'ok' });
      const refreshed = await client.credentials.refresh({ name: 'e2e-refresh.json' });
      expect(refreshed).toMatchObject({ ok: true, auth: { id: 'e2e-refresh.json', provider: 'claude', status: 'active' } });

      const missing = (await client.credentials.refresh({ name: 'nope.json' }).catch((e: unknown) => e)) as CpaHttpError;
      expect(missing.status).toBe(404);
      expect(missing.errorCode).toBe('auth file not found');
    });

    it('reconciles by owner and revision across a CPA rewrite', async () => {
      const owner = 'e2e-reconcile';
      const files = [
        { name: 'e2e-reconcile-a.json', content: { type: 'claude', email: 'reconcile-a@example.com', api_key: 'sk-a' }, revision: 'r1' },
        { name: 'e2e-reconcile-b.json', content: { type: 'claude', email: 'reconcile-b@example.com', api_key: 'sk-b' }, revision: 'r1' },
      ];
      try {
        await expect(client.credentials.reconcile({ owner, files })).resolves.toEqual({
          uploaded: ['e2e-reconcile-a.json', 'e2e-reconcile-b.json'],
          deleted: [],
          unchanged: [],
          adopted: [],
        });
        await client.credentials.upload({
          name: 'e2e-reconcile-other.json',
          content: { type: 'claude', email: 'other@example.com', api_key: 'sk-other', 'x-cpajs': { owner: 'someone-else', revision: 'r1' } },
        });

        // A management write makes CPA rewrite the file. The unknown marker must survive.
        await client.credentials.patchFields({ name: 'e2e-reconcile-a.json', priority: 9 });
        const rewritten = JSON.parse(await (await client.credentials.download('e2e-reconcile-a.json')).text()) as Record<string, unknown>;
        expect(rewritten['x-cpajs']).toEqual({ owner, revision: 'r1' });

        await expect(
          client.credentials.reconcile({ owner, files: [files[0]!, { ...files[1]!, revision: 'r2' }] }),
        ).resolves.toEqual({ uploaded: ['e2e-reconcile-b.json'], deleted: [], unchanged: ['e2e-reconcile-a.json'], adopted: [] });

        await expect(client.credentials.reconcile({ owner, files: [files[0]!] })).resolves.toEqual({
          uploaded: [],
          deleted: ['e2e-reconcile-b.json'],
          unchanged: ['e2e-reconcile-a.json'],
          adopted: [],
        });
        expect(await client.credentials.get('e2e-reconcile-other.json')).toBeDefined();
      } finally {
        await client.credentials.delete(['e2e-reconcile-a.json', 'e2e-reconcile-b.json', 'e2e-reconcile-other.json']).catch(() => {});
      }
    });

    it('refuses an unmarked file and adopts it when asked', async () => {
      const name = 'e2e-reconcile-legacy.json';
      const owner = 'e2e-adopt';
      const desired = (revision: string) => ({
        name,
        content: { type: 'claude', email: 'legacy@example.com', api_key: 'sk-new' },
        revision,
      });
      try {
        await client.credentials.upload({
          name,
          content: { type: 'claude', email: 'legacy@example.com', api_key: 'sk-legacy', chat_seed: 'seed-token', access_token: 'token-legacy-1' },
        });

        const refused = (await client.credentials.reconcile({ owner, files: [desired('r1')] }).catch((e: unknown) => e)) as CpaReconcileError;
        expect(refused).toBeInstanceOf(CpaReconcileError);
        expect(refused).toMatchObject({ code: 'unmarked', file: name });
        const untouched = JSON.parse(await (await client.credentials.download(name)).text()) as Record<string, unknown>;
        expect(untouched).toMatchObject({ api_key: 'sk-legacy', chat_seed: 'seed-token' });
        expect(untouched['x-cpajs']).toBeUndefined();

        const adopted = await client.credentials.reconcile({
          owner,
          files: [desired('r1')],
          adopt: (file, body) => {
            if (file !== name) return undefined;
            expect(body).toMatchObject({ api_key: 'sk-legacy', chat_seed: 'seed-token' });
            return { revision: 'r1', remove: ['chat_seed'] };
          },
        });
        expect(adopted).toEqual({ uploaded: [], deleted: [], unchanged: [name], adopted: [name] });
        const claimed = JSON.parse(await (await client.credentials.download(name)).text()) as Record<string, unknown>;
        expect(claimed).toMatchObject({
          api_key: 'sk-legacy',
          access_token: 'token-legacy-1',
          'x-cpajs': { owner, revision: 'r1' },
        });
        expect(claimed).not.toHaveProperty('chat_seed');

        await expect(client.credentials.reconcile({ owner, files: [desired('r2')] })).resolves.toEqual({
          uploaded: [name],
          deleted: [],
          unchanged: [],
          adopted: [],
        });
        const replaced = JSON.parse(await (await client.credentials.download(name)).text()) as Record<string, unknown>;
        expect(replaced).toMatchObject({ api_key: 'sk-new', 'x-cpajs': { owner, revision: 'r2' } });
      } finally {
        await client.credentials.delete(name).catch(() => {});
      }
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

    it('imports a generated Vertex service account', async () => {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const project = 'cpajs-e2e';
      const email = 'cpajs-e2e@example.iam.gserviceaccount.com';
      const serviceAccount = {
        type: 'service_account',
        project_id: project,
        private_key_id: 'e2e-key-id',
        private_key: privateKey,
        client_email: email,
        client_id: '1234567890',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(email)}`,
      };
      const result = await client.oauth.importVertex({ serviceAccount, location: 'europe-west4' });
      expect(result).toMatchObject({ status: 'ok', project_id: project, email, location: 'europe-west4' });
      expect(result['auth-file'].endsWith(`vertex-${project}.json`)).toBe(true);
      const entry = await client.credentials.get(`vertex-${project}.json`);
      expect(entry).toMatchObject({ provider: 'vertex', name: `vertex-${project}.json` });
      await expect(client.credentials.delete(`vertex-${project}.json`)).resolves.toEqual({ status: 'ok' });
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

    it('reads usage and pops the queue destructively', async () => {
      await expect(client.usage.apiKeys()).resolves.toBeTypeOf('object');
      const deadline = Date.now() + 10_000;
      let records = await client.usage.popQueue(100);
      while (records.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        records = await client.usage.popQueue(100);
      }
      expect(records.length).toBeGreaterThan(0);
      expect(records[0]).toMatchObject({ model: 'fake-model', failed: false });
      // The route removes what it returns.
      await expect(client.usage.popQueue(100)).resolves.toEqual([]);
    });

    it('downloads request error logs and request logs as attachments', async () => {
      const failed = await fetch(`${server.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${MODEL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'missing-e2e-model', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(failed.status).toBe(400);

      await eventually(async () => (await client.logs.listErrorLogs()).files.length > 0);
      const file = (await client.logs.listErrorLogs()).files[0]!;
      expect(file.name).toMatch(/^error-.+\.log$/);

      const errorLog = await client.logs.downloadErrorLog(file.name);
      expect(errorLog.filename).toBe(file.name);
      const text = await errorLog.blob.text();
      expect(text).toContain('missing-e2e-model');

      // The request-log route matches the last eight characters of the request ID,
      // which CPA also uses as the file-name suffix.
      const requestId = file.name.replace(/\.log$/, '').slice(-8);
      const requestLog = await client.logs.downloadRequestLog(requestId);
      expect(requestLog.filename).toBe(file.name);
      expect(await requestLog.blob.text()).toBe(text);
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

      const parsed = await client.requests.apiCallJson<{ method: string; auth: string; body: string }>({
        method: 'post',
        url: `${upstream.url}/echo`,
        header: { Authorization: 'Bearer abc' },
        data: '{"x":1}',
      });
      expect(parsed).toMatchObject({ status: 201, data: { method: 'POST', auth: 'Bearer abc', body: '{"x":1}' } });

      const missingToken = (await client.requests
        .apiCallJson({ auth_index: '0000000000000000', method: 'GET', url: `${upstream.url}/echo`, header: { Authorization: 'Bearer $TOKEN$' } })
        .catch((e: unknown) => e)) as CpaCredentialTokenError;
      expect(missingToken).toBeInstanceOf(CpaCredentialTokenError);
      expect(missingToken.status).toBe(400);
      expect(missingToken.errorCode).toBe('auth credential not found for auth_index');

      const upstreamError = (await client.requests
        .apiCallJson({ method: 'GET', url: `${upstream.url}/missing` })
        .catch((e: unknown) => e)) as CpaUpstreamError;
      expect(upstreamError).toBeInstanceOf(CpaUpstreamError);
      expect(upstreamError.status).toBe(404);
    });

    it('lists plugins', async () => {
      const list = await client.plugins.list();
      expect(list).toMatchObject({ plugins_enabled: false, plugins: [] });
      const error = (await client.plugins.delete('not-installed').catch((e: unknown) => e)) as CpaHttpError;
      expect(error.status).toBe(404);
      expect(error.errorCode).toBe('plugin_not_found');
    });

    it('reports plugin quota and reset error paths', async () => {
      const missingQuota = (await client.plugins.quota('fake-plugin', '').catch((e: unknown) => e)) as CpaHttpError;
      expect(missingQuota.status).toBe(400);
      expect(missingQuota.errorCode).toBe('auth_index is required');
      const missingReset = (await client.plugins.resetQuota('fake-plugin', '').catch((e: unknown) => e)) as CpaHttpError;
      expect(missingReset.status).toBe(400);
      expect(missingReset.errorCode).toBe('auth_index is required');

      const unknownQuota = (await client.plugins.quota('fake-plugin', '0000000000000000').catch((e: unknown) => e)) as CpaHttpError;
      expect(unknownQuota.status).toBe(404);
      expect(unknownQuota.errorCode).toBe('auth not found');
      const unknownReset = (await client.plugins.resetQuota('fake-plugin', '0000000000000000').catch((e: unknown) => e)) as CpaHttpError;
      expect(unknownReset.status).toBe(404);
      expect(unknownReset.errorCode).toBe('auth not found');

      const credential = await client.credentials.get('e2e-refresh.json');
      expect(credential).toBeDefined();
      const noProvider = (await client.plugins.quota('fake-plugin', credential!.auth_index!).catch((e: unknown) => e)) as CpaHttpError;
      expect(noProvider.status).toBe(404);
      expect(noProvider.errorCode).toBe('quota provider not found for plugin');
      const noProviderReset = (await client.plugins.resetQuota('fake-plugin', credential!.auth_index!).catch((e: unknown) => e)) as CpaHttpError;
      expect(noProviderReset.status).toBe(404);
      expect(noProviderReset.errorCode).toBe('quota provider not found for plugin');
    });
  });
});

describe.skipIf(!binary)('management key modes', () => {
  it('passes the key through MANAGEMENT_PASSWORD only with viaEnvironment', async () => {
    const server = await startServer({
      binaryPath: binary!,
      management: { key: 'via-env-key', viaEnvironment: true },
      localModel: true,
      config: { management: { 'disable-control-panel': true } },
    });
    try {
      expect('managementKey' in server).toBe(false);
      const written = parse(await readFile(server.configPath, 'utf8')) as {
        management: Record<string, unknown>;
      };
      expect(written.management['secret-key']).toBeUndefined();
      expect(written.management['allow-remote']).toBeUndefined();
      const client = createClient({ baseUrl: server.origin, managementKey: 'via-env-key' });
      await expect(client.server.info()).resolves.toMatchObject({ version: CPA_RELEASE.version });
    } finally {
      await server.stop();
    }
  });

  it('rejects conflicting management key sources', async () => {
    await expect(
      startServer({
        binaryPath: binary!,
        management: { key: 'a' },
        config: { management: { 'secret-key': 'b' } },
      }),
    ).rejects.toMatchObject({ code: 'invalid-options' });
    await expect(
      startServer({ binaryPath: binary!, configPath: '/tmp/cpajs-not-read.yaml', management: { key: 'a' } }),
    ).rejects.toMatchObject({ code: 'invalid-options' });
  });
});

describe.skipIf(!binary)('server with an existing config file', () => {
  it('hands the file to CPA, which persists a hashed secret', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { findFreePort } = await import('../../src/server/readiness.ts');
    const dir = await mkdtemp(join(tmpdir(), 'cpajs-e2e-'));
    try {
      const reservation = await findFreePort('127.0.0.1');
      const port = reservation.port;
      const configPath = join(dir, 'config.yaml');
      await writeFile(
        configPath,
        `config-version: 8\nserver:\n  host: 127.0.0.1\n  port: ${port}\nmanagement:\n  secret-key: file-secret\n  disable-control-panel: true\noauth:\n  auth-dir: ${JSON.stringify(join(dir, 'auths'))}\n`,
      );
      await reservation.release();
      const lines: string[] = [];
      const server = await startServer({ binaryPath: binary!, configPath, localModel: true, onLog: (l) => lines.push(l.line) });
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

describe.skipIf(!binary)('managed config ownership', () => {
  it('keeps management API changes across stop and start with the same stateDir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cpajs-e2e-'));
    const reservation = await findFreePort('127.0.0.1');
    const port = reservation.port;
    await reservation.release();
    let first: CpaServer | undefined;
    let second: CpaServer | undefined;
    try {
      first = await startServer({
        binaryPath: binary!,
        stateDir: dir,
        port,
        managementKey: MANAGEMENT_KEY,
        localModel: true,
        config: { routing: { strategy: 'fill-first' } },
      });
      expect(first.port).toBe(port);
      const configPath = first.configPath;
      const text = await readFile(configPath, 'utf8');
      expect(text).toContain('config-version: 8');
      expect(text).not.toMatch(/^\{/);

      const client = createClient({ baseUrl: first.origin, managementKey: MANAGEMENT_KEY });
      await client.config.set('routing/strategy', 'round-robin');
      expect((await client.config.getPath('routing/strategy')).data).toBe('round-robin');

      await first.stop();
      first = undefined;

      const codes: string[] = [];
      second = await startServer({
        binaryPath: binary!,
        stateDir: dir,
        managementKey: MANAGEMENT_KEY,
        localModel: true,
        onWarning: (w) => codes.push(w.code),
        config: { routing: { strategy: 'fill-first' } },
      });
      expect(second.configPath).toBe(configPath);
      expect(second.port).toBe(port);
      expect(codes).toContain('configReused');
      const restarted = createClient({ baseUrl: second.origin, managementKey: MANAGEMENT_KEY });
      expect((await restarted.config.getPath('routing/strategy')).data).toBe('round-robin');
    } finally {
      await second?.stop();
      await first?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!binary)('plugin store against a local registry', () => {
  it('lists and installs a direct plugin from plugins.store-sources without external network', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cpajs-store-'));
    const pluginsDir = join(dir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
    const pluginData = Buffer.from('cpajs e2e plugin placeholder');
    // CPA picks the artifact for its own GOOS/GOARCH and the library extension for
    // its GOOS (internal/pluginstore/install.go), so describe the host platform.
    const goos = process.platform === 'win32' ? 'windows' : process.platform;
    const goarch = ({ x64: 'amd64', arm64: 'arm64', ia32: '386' } as Record<string, string>)[process.arch] ?? process.arch;
    const extension = goos === 'darwin' ? '.dylib' : goos === 'windows' ? '.dll' : '.so';
    const archive = storedZip(`local-test${extension}`, pluginData);
    let registryBody = '';
    const registryServer = createServer((req, res) => {
      if (req.url === '/registry.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(registryBody);
        return;
      }
      if (req.url === '/local-test.zip') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(archive);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => registryServer.listen(0, '127.0.0.1', resolve));
    const registryPort = (registryServer.address() as { port: number }).port;
    const artifactUrl = `http://127.0.0.1:${registryPort}/local-test.zip`;
    const registryUrl = `http://127.0.0.1:${registryPort}/registry.json`;
    registryBody = JSON.stringify({
      schema_version: 2,
      plugins: [
        {
          id: 'local-test',
          name: 'Local Test',
          description: 'Fixture served from a local registry',
          author: 'cpajs',
          version: '1.0.0',
          install: {
            type: 'direct',
            artifacts: [{ goos, goarch, url: artifactUrl, sha256: sha256(archive), size: archive.length }],
          },
        },
      ],
    });

    const managementKey = 'store-management-key';
    // The built-in official source cannot be disabled. Point HTTPS at a closed port so its
    // probe fails immediately instead of reaching the network; the local registry below
    // stays on loopback.
    const deadProxy = 'http://127.0.0.1:1';
    const server = await startServer({
      binaryPath: binary!,
      managementKey,
      stateDir: dir,
      config: {
        management: { 'disable-control-panel': true },
        plugins: {
          enabled: true,
          dir: pluginsDir,
          'store-sources': [registryUrl],
          // Plain http is refused unless a matching allow-insecure rule exists.
          'store-auth': [{ match: `http://127.0.0.1:${registryPort}`, 'allow-insecure': true }],
        },
      },
      env: {
        HTTPS_PROXY: deadProxy,
        https_proxy: deadProxy,
        HTTP_PROXY: '',
        http_proxy: '',
        ALL_PROXY: '',
        all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    });
    const client = createClient({ baseUrl: server.origin, managementKey, timeoutMs: 20_000 });
    try {
      const store = await client.plugins.store();
      expect(store.plugins_enabled).toBe(true);
      expect(store.sources.some((source) => source.url === registryUrl)).toBe(true);
      const entry = store.plugins.find((plugin) => plugin.id === 'local-test');
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({ install_type: 'direct', installed: false, version: '1.0.0' });

      const installed = await client.plugins.install('local-test', { source: entry!.source_id });
      expect(installed).toMatchObject({
        status: 'installed',
        id: 'local-test',
        version: '1.0.0',
        install_type: 'direct',
        plugins_enabled: true,
        restart_required: false,
      });
      expect(existsSync(installed.path)).toBe(true);
      expect(readFileSync(installed.path).equals(pluginData)).toBe(true);

      const list = await client.plugins.list();
      expect(list.plugins.find((plugin) => plugin.id === 'local-test')).toMatchObject({ enabled: true });
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => registryServer.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
