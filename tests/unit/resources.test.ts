import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CpaCredentialTokenError,
  CpaHttpError,
  CpaReconcileError,
  CpaResponseError,
  CpaUpstreamError,
  type CpaApiKeyProvider,
  type CpaConfig,
  type CredentialContent,
} from '../../src/client/index.ts';
import { attachmentFilename } from '../../src/client/resources/download.ts';
import { mockClient } from './helpers.ts';

const ok = { status: 'ok', 'config-version': 8 };

describe('attachmentFilename', () => {
  it('prefers the RFC 5987 filename* parameter and decodes it', () => {
    expect(
      attachmentFilename(
        new Headers({ 'Content-Disposition': `attachment; filename="fallback.log"; filename*=UTF-8''%E6%97%A5%E5%BF%97.log` }),
      ),
    ).toBe('日志.log');
    // The encoded value may itself be quoted.
    expect(
      attachmentFilename(new Headers({ 'Content-Disposition': `attachment; filename*=UTF-8''"na%C3%AFve.log"` })),
    ).toBe('naïve.log');
  });

  it('falls back to filename when filename* is malformed, and returns undefined without a header', () => {
    expect(
      attachmentFilename(new Headers({ 'Content-Disposition': 'attachment; filename="fallback.log"; filename*=UTF-8\'\'%E6' })),
    ).toBe('fallback.log');
    expect(attachmentFilename(new Headers({ 'Content-Disposition': 'attachment' }))).toBeUndefined();
    expect(attachmentFilename(new Headers())).toBeUndefined();
  });
});

describe('config', () => {
  it('returns data with the ETag and sends If-Match on writes', async () => {
    const { client, calls } = mockClient((req) =>
      req.method === 'GET'
        ? Response.json({ 'config-version': 8 }, { headers: { ETag: '"abc"' } })
        : Response.json(ok, { headers: { ETag: '"def"' } }),
    );
    const read = await client.config.get();
    expect(read).toEqual({ data: { 'config-version': 8 }, etag: '"abc"' });
    const written = await client.config.patch({ routing: { strategy: 'fill-first' } }, { ifMatch: read.etag! });
    expect(written).toEqual({ data: ok, etag: '"def"' });
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.url.pathname).toBe('/v8/management/config');
    expect(calls[1]!.headers.get('if-match')).toBe('"abc"');
    expect(JSON.parse(calls[1]!.body)).toEqual({ routing: { strategy: 'fill-first' } });
  });

  it('types set and patchPath values by path', async () => {
    const { client, calls } = mockClient(() => Response.json(ok));
    // Values typed as CpaConfig sections must be accepted, although interfaces have no index signature.
    const apiKeys: CpaConfig['api-keys'] = { claude: [{ keys: [{ 'api-key': 'k' }] }] };
    const routing: NonNullable<CpaConfig['routing']> = { strategy: 'fill-first' };
    await client.config.set('api-keys', apiKeys!);
    await client.config.patchPath('routing', routing);
    await client.config.set('oauth/model-alias/claude', [{ name: 'a', alias: 'b' }]);
    await client.config.set('plugins/configs/my-plugin/option', 'anything');
    const dynamic: string = 'routing/strategy';
    await client.config.set(dynamic, 1);
    // @ts-expect-error a known path takes its own value type
    await client.config.set('routing/retry/request-retry', 'two');
    // @ts-expect-error unknown keys inside a known section are rejected
    await client.config.patchPath('routing', { retyr: {} });
    expect(calls.map((c) => c.url.pathname.replace('/v8/management/config/', ''))).toEqual([
      'api-keys',
      'routing',
      'oauth/model-alias/claude',
      'plugins/configs/my-plugin/option',
      'routing/strategy',
      'routing/retry/request-retry',
      'routing',
    ]);
  });

  it('types tuple and union paths by the value at that path', async () => {
    const { client } = mockClient(() => Response.json(ok));
    type ApiKeys = NonNullable<CpaConfig['api-keys']>;
    type Routing = NonNullable<CpaConfig['routing']>;

    // A tuple path gets the same value type as its slash-separated form.
    await client.config.set(['api-keys', 'gemini'], [{ keys: [{ 'api-key': 'k' }] }]);
    await client.config.patchPath(['routing', 'retry'], { 'request-retry': 2 });
    await client.config.update(['routing', 'strategy'], (current) => {
      expectTypeOf(current).toEqualTypeOf<Routing['strategy'] | undefined>();
      return current;
    });
    const tuplePath = ['api-keys', 'claude'] as const;
    await client.config.set(tuplePath, [{ keys: [{ 'api-key': 'k' }] }]);

    // Template-literal unions take the union of the branches' value types.
    const channel = 'gemini' as 'gemini' | 'claude';
    await client.config.set(`api-keys/${channel}`, [{ keys: [{ 'api-key': 'k' }] }]);
    await client.config.update(`api-keys/${channel}`, (current) => {
      expectTypeOf(current).toEqualTypeOf<ApiKeys['gemini' | 'claude'] | undefined>();
      return current;
    });

    // Tuple unions resolve per branch too.
    const provider = 'gemini' as CpaApiKeyProvider;
    await client.config.set(['api-keys', provider], [{ keys: [{ 'api-key': 'k' }] }]);
    await client.config.update(['api-keys', provider], (current) => {
      expectTypeOf(current).toEqualTypeOf<ApiKeys[CpaApiKeyProvider] | undefined>();
      return current;
    });

    // Broad strings and arrays still accept any JSON-serialisable value.
    const dynamic: string = 'routing/strategy';
    const dynamicProvider: string = 'gemini';
    const broad: readonly string[] = ['api-keys', 'gemini'];
    await client.config.set(dynamic, 1);
    await client.config.set(`api-keys/${dynamicProvider}`, { anything: true });
    await client.config.set(broad, [1, 2, 3]);

    // @ts-expect-error a known tuple path takes its own value type
    await client.config.set(['routing', 'retry', 'request-retry'], 'two');
    // @ts-expect-error a union of known paths takes the union of their value types
    await client.config.set(['api-keys', channel], 'not-a-group');
  });

  it('maps every route', async () => {
    const { client, calls } = mockClient((req) => (req.url.pathname.endsWith('.yaml') && req.method === 'GET' ? new Response('a: 1\n') : Response.json(ok)));
    await client.config.replace({ 'config-version': 8 });
    expect((await client.config.getYaml()).data).toBe('a: 1\n');
    await client.config.replaceYaml('config-version: 8\n');
    await client.config.getPath('server/port');
    await client.config.set(['plugins', 'configs', 'my plugin'], { enabled: true });
    await client.config.patchPath('routing', { retry: { 'request-retry': 1 } });
    await client.config.delete('routing/strategy');
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'PUT /v8/management/config',
      'GET /v8/management/config.yaml',
      'PUT /v8/management/config.yaml',
      'GET /v8/management/config/server/port',
      'PUT /v8/management/config/plugins/configs/my%20plugin',
      'PATCH /v8/management/config/routing',
      'DELETE /v8/management/config/routing/strategy',
    ]);
    expect(calls[2]!.contentType).toBe('application/yaml');
    expect(calls[2]!.body).toBe('config-version: 8\n');
    expect(calls[6]!.body).toBe('');
  });

  it('update reads, strips auth_index, writes with If-Match and retries a 412', async () => {
    let reads = 0;
    let writes = 0;
    const { client, calls } = mockClient((req) => {
      if (req.method === 'GET') {
        reads++;
        return Response.json(
          { claude: [{ keys: [{ 'api-key': `k${reads}`, auth_index: 'key-id' }], auth_index: 'group-id' }] },
          { headers: { ETag: `"read-${reads}"` } },
        );
      }
      writes++;
      if (writes === 1) return Response.json({ error: 'precondition_failed' }, { status: 412 });
      return Response.json(ok, { headers: { ETag: '"written"' } });
    });
    const seen: unknown[] = [];
    const result = await client.config.update('api-keys', (current) => {
      seen.push(current);
      return current;
    });
    expect(reads).toBe(2);
    expect(writes).toBe(2);
    expect(result).toEqual({ written: true, etag: '"written"' });
    expect(JSON.stringify(seen)).not.toContain('auth_index');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET', 'PUT']);
    expect(calls[1]!.headers.get('if-match')).toBe('"read-1"');
    expect(calls[3]!.headers.get('if-match')).toBe('"read-2"');
    expect(calls[3]!.body).not.toContain('auth_index');
  });

  it('update skips the write when fn returns undefined', async () => {
    const { client, calls } = mockClient(() => Response.json({ strategy: 'fill-first' }, { headers: { ETag: '"current"' } }));
    await expect(client.config.update('routing/strategy', () => undefined)).resolves.toEqual({
      written: false,
      etag: '"current"',
    });
    expect(calls).toHaveLength(1);
  });

  it('update passes undefined for a missing node and writes without If-Match', async () => {
    const { client, calls } = mockClient((req) =>
      req.method === 'GET'
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json(ok, { headers: { ETag: '"created"' } }),
    );
    const seen: unknown[] = [];
    await expect(
      client.config.update('routing/strategy', (current) => {
        seen.push(current);
        return 'fill-first';
      }),
    ).resolves.toEqual({ written: true, etag: '"created"' });
    expect(seen).toEqual([undefined]);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]!.headers.get('if-match')).toBeNull();
    expect(calls[1]!.body).toBe('"fill-first"');
  });

  it('update serialises concurrent calls for the same path', async () => {
    const events: string[] = [];
    let release = (): void => {};
    let firstRead = (): void => {};
    const readStarted = new Promise<void>((resolve) => {
      firstRead = resolve;
    });
    let reads = 0;
    const { client } = mockClient((req) => {
      if (req.method !== 'GET') return Response.json(ok, { headers: { ETag: '"written"' } });
      const response = Response.json({}, { headers: { ETag: `"e${++reads}"` } });
      if (reads === 1) firstRead();
      return response;
    });
    const one = client.config.update('routing', async () => {
      events.push('one-start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push('one-end');
      return {};
    });
    await readStarted;
    const two = client.config.update('routing', () => {
      events.push('two-start');
      return undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['one-start']);
    release();
    await one;
    await two;
    expect(events).toEqual(['one-start', 'one-end', 'two-start']);
  });

  it('reconcile writes nothing when the values match, ignoring auth_index', async () => {
    const { client, calls } = mockClient(() =>
      Response.json(
        {
          'config-version': 8,
          routing: { strategy: 'fill-first' },
          'api-keys': { claude: [{ keys: [{ 'api-key': 'k', auth_index: 'injected' }], auth_index: 'group' }] },
        },
        { headers: { ETag: '"same"' } },
      ),
    );
    await expect(
      client.config.reconcile({
        'config-version': 8,
        routing: { strategy: 'fill-first' },
        'api-keys': { claude: [{ keys: [{ 'api-key': 'k' }] }] },
      }),
    ).resolves.toEqual({ written: false, changed: [], etag: '"same"' });
    expect(calls).toHaveLength(1);
  });

  it('reconcile replaces sections wholesale, removes nested keys and then converges', async () => {
    let doc: CpaConfig = {
      'config-version': 8,
      'api-keys': {
        claude: [{ name: 'a', keys: [{ 'api-key': 'k', auth_index: 'injected' }] }],
        codex: [{ name: 'b', keys: [{ 'api-key': 'k2' }] }],
      },
    };
    let version = 0;
    const { client, calls } = mockClient((req) => {
      if (req.method === 'GET') return Response.json(structuredClone(doc), { headers: { ETag: `"v${version}"` } });
      expect(req.method).toBe('PUT');
      expect(req.url.pathname).toBe('/v8/management/config/api-keys');
      doc = { ...doc, 'api-keys': JSON.parse(req.body) };
      version++;
      return Response.json(ok, { headers: { ETag: `"v${version}"` } });
    });
    const target: CpaConfig = { 'api-keys': { claude: [{ name: 'a', keys: [{ 'api-key': 'k' }] }] } };
    await expect(client.config.reconcile(target)).resolves.toEqual({ written: true, changed: ['api-keys'], etag: '"v1"' });
    expect(doc['api-keys']).toEqual(target['api-keys']);
    expect(doc['api-keys']).not.toHaveProperty('codex');

    await expect(client.config.reconcile(target)).resolves.toEqual({ written: false, changed: [], etag: '"v1"' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('reconcile chains the ETag across two changed sections', async () => {
    const doc = { 'config-version': 8, routing: { strategy: 'round-robin' }, access: { 'api-keys': ['old'] } };
    let writes = 0;
    const { client, calls } = mockClient((req) => {
      if (req.method === 'GET') return Response.json(doc, { headers: { ETag: '"read"' } });
      writes++;
      return Response.json(ok, { headers: { ETag: writes === 1 ? '"one"' : '"two"' } });
    });
    await expect(
      client.config.reconcile({ routing: { strategy: 'fill-first' }, access: { 'api-keys': ['new'] } }),
    ).resolves.toEqual({ written: true, changed: ['routing', 'access'], etag: '"two"' });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /v8/management/config',
      'PUT /v8/management/config/routing',
      'PUT /v8/management/config/access',
    ]);
    expect(calls[1]!.headers.get('if-match')).toBe('"read"');
    expect(calls[2]!.headers.get('if-match')).toBe('"one"');
    expect(JSON.parse(calls[1]!.body)).toEqual({ strategy: 'fill-first' });
    expect(JSON.parse(calls[2]!.body)).toEqual({ 'api-keys': ['new'] });
  });

  it('reconcile re-reads and recomputes when a later write gets 412', async () => {
    const doc: CpaConfig = { 'config-version': 8, routing: { strategy: 'round-robin' }, access: { 'api-keys': ['old'] } };
    let reads = 0;
    let writes = 0;
    const { client, calls } = mockClient((req) => {
      if (req.method === 'GET') {
        reads++;
        return Response.json(structuredClone(doc), { headers: { ETag: `"read-${reads}"` } });
      }
      writes++;
      if (writes === 2) return Response.json({ error: 'precondition_failed' }, { status: 412 });
      const key = req.url.pathname.split('/').at(-1)!;
      (doc as Record<string, unknown>)[key] = JSON.parse(req.body);
      return Response.json(ok, { headers: { ETag: `"write-${writes}"` } });
    });
    await expect(
      client.config.reconcile({ routing: { strategy: 'fill-first' }, access: { 'api-keys': ['new'] } }),
    ).resolves.toEqual({ written: true, changed: ['routing', 'access'], etag: '"write-3"' });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /v8/management/config',
      'PUT /v8/management/config/routing',
      'PUT /v8/management/config/access',
      'GET /v8/management/config',
      'PUT /v8/management/config/access',
    ]);
    expect(calls[1]!.headers.get('if-match')).toBe('"read-1"');
    expect(calls[2]!.headers.get('if-match')).toBe('"write-1"');
    expect(calls[4]!.headers.get('if-match')).toBe('"read-2"');
    expect(doc.routing).toEqual({ strategy: 'fill-first' });
    expect(doc.access).toEqual({ 'api-keys': ['new'] });
  });

  it('refuses an empty path for node operations', async () => {
    const { client } = mockClient();
    expect(() => client.config.delete('')).toThrow(/must not be empty/);
  });
});

describe('credentials', () => {
  it('uploads one file as a raw JSON body with ?name', async () => {
    const { client, calls } = mockClient();
    await client.credentials.upload({ name: 'codex-a.json', content: { type: 'codex', email: 'a@example.com' } });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.search).toBe('?name=codex-a.json');
    expect(calls[0]!.contentType).toBe('application/json');
    expect(JSON.parse(calls[0]!.body)).toEqual({ type: 'codex', email: 'a@example.com' });
  });

  it('uploads several files as multipart', async () => {
    const { client, calls } = mockClient(() => Response.json({ status: 'ok', uploaded: 2, files: ['a.json', 'b.json'] }));
    await client.credentials.uploadMany([
      { name: 'a.json', content: '{"type":"claude"}' },
      { name: 'b.json', content: new TextEncoder().encode('{"type":"codex"}') },
    ]);
    const files = calls[0]!.formData!.getAll('file') as File[];
    expect(files.map((f) => f.name)).toEqual(['a.json', 'b.json']);
    expect(await files[1]!.text()).toBe('{"type":"codex"}');
  });

  it('reconciles owned files by revision and prunes the rest', async () => {
    const markers: Record<string, Record<string, unknown>> = {
      'chat-a.json': { owner: 'chat', revision: 'r1' },
      'chat-b.json': { owner: 'chat', revision: 'r1' },
      'chat-stale.json': { owner: 'chat', revision: 'r1' },
      'other.json': { owner: 'other', revision: 'r1' },
    };
    const { client, calls } = mockClient((req) => {
      if (req.method === 'GET' && req.url.pathname === '/v8/management/credentials') {
        return Response.json({
          observed_at: '',
          files: [
            { name: 'chat-a.json', source: 'file' },
            { name: 'chat-b.json', source: 'file' },
            { name: 'chat-stale.json', source: 'file' },
            { name: 'other.json', source: 'file' },
            { name: 'chat-memory', source: 'memory' },
          ],
        });
      }
      if (req.url.pathname.endsWith('/download')) {
        const name = req.url.searchParams.get('name')!;
        return Response.json({ type: 'claude', email: `${name}@example.com`, 'x-cpajs': markers[name] });
      }
      return Response.json({ status: 'ok' });
    });

    const added = { type: 'claude', email: 'added@example.com' };
    const result = await client.credentials.reconcile({
      owner: 'chat',
      files: [
        // Same revision: CPA may have rewritten the tokens, but this must not be re-uploaded.
        { name: 'chat-a.json', content: { type: 'claude', access_token: 'rewritten-by-cpa' }, revision: 'r1' },
        { name: 'chat-b.json', content: { type: 'claude', email: 'b@example.com' }, revision: 'r2' },
        { name: 'chat-c.json', content: added, revision: 'r9' },
      ],
    });

    expect(result).toEqual({ uploaded: ['chat-b.json', 'chat-c.json'], deleted: ['chat-stale.json'], unchanged: ['chat-a.json'], adopted: [] });
    expect(calls.filter((c) => c.url.pathname.endsWith('/download')).map((c) => c.url.searchParams.get('name'))).toEqual([
      'chat-a.json',
      'chat-b.json',
      'chat-stale.json',
      'other.json',
    ]);
    const uploads = calls.filter((c) => c.method === 'POST');
    expect(uploads.map((c) => c.url.search)).toEqual(['?name=chat-b.json', '?name=chat-c.json']);
    expect(JSON.parse(uploads[1]!.body)).toEqual({ type: 'claude', email: 'added@example.com', 'x-cpajs': { owner: 'chat', revision: 'r9' } });
    expect(added).toEqual({ type: 'claude', email: 'added@example.com' });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.search)).toEqual(['?name=chat-stale.json']);
  });

  it('leaves unmanaged files alone when prune is off', async () => {
    const { client, calls } = mockClient((req) => {
      if (req.method === 'GET' && req.url.pathname === '/v8/management/credentials') {
        return Response.json({
          observed_at: '',
          files: [
            { name: 'chat-a.json', source: 'file' },
            { name: 'chat-stale.json', source: 'file' },
            { name: 'other.json', source: 'file' },
          ],
        });
      }
      return Response.json({ type: 'claude', 'x-cpajs': { owner: 'chat', revision: 'r1' } });
    });

    const result = await client.credentials.reconcile({
      owner: 'chat',
      files: [{ name: 'chat-a.json', content: { type: 'claude' }, revision: 'r1' }],
      prune: false,
    });

    expect(result).toEqual({ uploaded: [], deleted: [], unchanged: ['chat-a.json'], adopted: [] });
    expect(calls.filter((c) => c.url.pathname.endsWith('/download')).map((c) => c.url.searchParams.get('name'))).toEqual(['chat-a.json']);
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('refuses to overwrite a file owned by someone else', async () => {
    const { client, calls } = mockClient((req) =>
      req.url.pathname.endsWith('/download')
        ? Response.json({ type: 'claude', 'x-cpajs': { owner: 'other', revision: 'r1' } })
        : Response.json({ observed_at: '', files: [{ name: 'other.json', source: 'file' }] }),
    );

    const error = (await client.credentials
      .reconcile({ owner: 'chat', files: [{ name: 'other.json', content: { type: 'claude' }, revision: 'r2' }] })
      .catch((e: unknown) => e)) as CpaReconcileError;
    expect(error).toBeInstanceOf(CpaReconcileError);
    expect(error).toMatchObject({ code: 'owned-by-other', file: 'other.json' });
    expect(error.message).toMatch(/belongs to owner "other", not "chat"/);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('refuses to overwrite an unmarked file by default', async () => {
    const legacy = { type: 'claude', chat_seed: 'seed-token', email: 'legacy@example.com' };
    const { client, calls } = mockClient((req) =>
      req.url.pathname.endsWith('/download')
        ? Response.json(legacy)
        : Response.json({ observed_at: '', files: [{ name: 'chat-legacy.json', source: 'file' }] }),
    );

    const error = (await client.credentials
      .reconcile({
        owner: 'chat',
        files: [{ name: 'chat-legacy.json', content: { type: 'claude', api_key: 'new' }, revision: 'r1' }],
      })
      .catch((e: unknown) => e)) as CpaReconcileError;

    expect(error).toBeInstanceOf(CpaReconcileError);
    expect(error).toMatchObject({ code: 'unmarked', file: 'chat-legacy.json' });
    expect(error.message).toMatch(/pass adopt/);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('adopts an unmarked file in place and keeps its tokens', async () => {
    const legacy = { type: 'claude', chat_seed: 'seed-token', email: 'legacy@example.com' };
    const { client, calls } = mockClient((req) => {
      if (req.method === 'GET' && req.url.pathname === '/v8/management/credentials') {
        return Response.json({ observed_at: '', files: [{ name: 'chat-legacy.json', source: 'file' }] });
      }
      if (req.url.pathname.endsWith('/download')) return Response.json(legacy);
      return Response.json({ status: 'ok' });
    });
    const seen: unknown[] = [];

    const result = await client.credentials.reconcile({
      owner: 'chat',
      files: [{ name: 'chat-legacy.json', content: { type: 'claude', api_key: 'new' }, revision: 'r1' }],
      adopt: (name, body) => {
        seen.push([name, body]);
        return 'r1';
      },
    });

    expect(seen).toEqual([['chat-legacy.json', legacy]]);
    expect(result).toEqual({ uploaded: [], deleted: [], unchanged: ['chat-legacy.json'], adopted: ['chat-legacy.json'] });
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body)).toEqual({ ...legacy, 'x-cpajs': { owner: 'chat', revision: 'r1' } });
    expect(legacy).toEqual({ type: 'claude', chat_seed: 'seed-token', email: 'legacy@example.com' });
  });

  it('uploads the desired content after adoption when the revision differs', async () => {
    const legacy = { type: 'claude', chat_seed: 'seed-token' };
    const { client, calls } = mockClient((req) => {
      if (req.method === 'GET' && req.url.pathname === '/v8/management/credentials') {
        return Response.json({ observed_at: '', files: [{ name: 'chat-legacy.json', source: 'file' }] });
      }
      if (req.url.pathname.endsWith('/download')) return Response.json(legacy);
      return Response.json({ status: 'ok' });
    });

    const result = await client.credentials.reconcile({
      owner: 'chat',
      files: [{ name: 'chat-legacy.json', content: { type: 'claude', api_key: 'new' }, revision: 'r2' }],
      adopt: () => 'legacy-r1',
    });

    expect(result).toEqual({ uploaded: ['chat-legacy.json'], deleted: [], unchanged: [], adopted: ['chat-legacy.json'] });
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => JSON.parse(call.body))).toEqual([
      { ...legacy, 'x-cpajs': { owner: 'chat', revision: 'legacy-r1' } },
      { type: 'claude', api_key: 'new', 'x-cpajs': { owner: 'chat', revision: 'r2' } },
    ]);
  });

  it('adopts an unmarked file in the prune range and then deletes it', async () => {
    const legacy = { type: 'claude', chat_seed: 'seed-token' };
    const { client, calls } = mockClient((req) => {
      if (req.method === 'GET' && req.url.pathname === '/v8/management/credentials') {
        return Response.json({ observed_at: '', files: [{ name: 'chat-old.json', source: 'file' }] });
      }
      if (req.url.pathname.endsWith('/download')) return Response.json(legacy);
      return Response.json({ status: 'ok' });
    });

    const result = await client.credentials.reconcile({
      owner: 'chat',
      files: [],
      adopt: (name) => (name === 'chat-old.json' ? 'r1' : undefined),
    });

    expect(result).toEqual({ uploaded: [], deleted: ['chat-old.json'], unchanged: [], adopted: ['chat-old.json'] });
    expect(calls.map((call) => `${call.method} ${call.url.search}`)).toEqual([
      'GET ',
      'GET ?name=chat-old.json',
      'POST ?name=chat-old.json',
      'DELETE ?name=chat-old.json',
    ]);
  });

  it('accepts JSON text and raw bytes as reconcile content', async () => {
    const { client, calls } = mockClient((req) =>
      req.method === 'GET' && req.url.pathname === '/v8/management/credentials'
        ? Response.json({ observed_at: '', files: [] })
        : Response.json({ status: 'ok' }),
    );

    const result = await client.credentials.reconcile({
      owner: 'chat',
      files: [
        { name: 'text.json', content: '{"type":"claude","api_key":"text"}', revision: 'r1' },
        { name: 'bytes.json', content: new TextEncoder().encode('{"type":"codex","api_key":"bytes"}'), revision: 'r1' },
      ],
    });

    expect(result).toEqual({ uploaded: ['text.json', 'bytes.json'], deleted: [], unchanged: [], adopted: [] });
    expect(calls.filter((call) => call.method === 'POST').map((call) => JSON.parse(call.body))).toEqual([
      { type: 'claude', api_key: 'text', 'x-cpajs': { owner: 'chat', revision: 'r1' } },
      { type: 'codex', api_key: 'bytes', 'x-cpajs': { owner: 'chat', revision: 'r1' } },
    ]);
  });

  it('rejects content that does not resolve to a JSON object before any request', async () => {
    const { client, calls } = mockClient();
    const file = (content: CredentialContent) => ({ name: 'bad.json', content, revision: 'r1' });

    await expect(client.credentials.reconcile({ owner: 'chat', files: [file('[1,2]')] })).rejects.toThrow(TypeError);
    await expect(client.credentials.reconcile({ owner: 'chat', files: [file('not json')] })).rejects.toThrow(
      /"bad.json" must be a JSON object/,
    );
    await expect(client.credentials.reconcile({ owner: 'chat', files: [file(new TextEncoder().encode('null'))] })).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it('rejects duplicate file names before making requests', async () => {
    const { client, calls } = mockClient();
    const file = { name: 'chat-a.json', content: { type: 'claude' }, revision: 'r1' };
    await expect(client.credentials.reconcile({ owner: 'chat', files: [file, file] })).rejects.toThrow(/more than once/);
    expect(calls).toEqual([]);
  });

  it('lists file and config credentials together', async () => {
    const { client, calls } = mockClient((req) => {
      if (req.url.pathname === '/v8/management/credentials') {
        return Response.json({
          observed_at: '',
          files: [
            { name: 'claude-a.json', auth_index: 'file-1', provider: 'claude', type: 'claude', label: 'a@example.com', disabled: false, source: 'file' },
            { name: 'runtime', auth_index: 'mem-1', provider: 'claude', type: 'claude', label: '', disabled: false, source: 'memory' },
          ],
        });
      }
      if (req.url.pathname === '/v8/management/config') {
        return Response.json({
          'config-version': 8,
          'api-keys': {
            claude: [{ name: 'team', keys: [{ 'api-key': 'k', auth_index: 'cfg-claude', models: [{ name: 'claude-sonnet', alias: 'sonnet' }] }] }],
            codex: [{ name: 'codex group', 'base-url': 'https://codex.test', keys: [{ 'api-key': 'k2' }] }],
            'openai-compatibility': [
              {
                name: 'fake',
                'base-url': 'https://fake.test/v1',
                keys: [],
                auth_index: 'cfg-openai',
                disabled: true,
                models: [{ name: 'fake-model', alias: 'fake' }],
              },
            ],
          },
        });
      }
      return Response.json({});
    });

    const entries = await client.credentials.listAll();
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ source: 'file', name: 'claude-a.json', auth_index: 'file-1', provider: 'claude' });
    expect(entries[0]!.raw).toMatchObject({ name: 'claude-a.json', source: 'file' });
    expect(entries[1]).toMatchObject({ source: 'config', provider: 'claude', label: 'team', auth_index: 'cfg-claude', disabled: false });
    expect(entries[1]!.name).toBeUndefined();
    expect(entries[2]).toMatchObject({ source: 'config', provider: 'codex', label: 'codex group', auth_index: '', disabled: false });
    expect(entries[3]).toMatchObject({ source: 'config', provider: 'fake', label: 'fake', auth_index: 'cfg-openai', disabled: true });
    expect(entries[3]!.raw).toMatchObject({ name: 'fake' });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['GET /v8/management/credentials', 'GET /v8/management/config']);
  });

  it('resolves config models with alias, key exclusions and overrides', async () => {
    const { client, calls } = mockClient((req) => {
      if (req.url.pathname === '/v8/management/config') {
        return Response.json({
          'config-version': 8,
          'api-keys': {
            claude: [
              {
                name: 'team',
                'excluded-models': ['*'],
                keys: [
                  {
                    'api-key': 'k',
                    auth_index: 'cfg-claude',
                    'excluded-models': ['op*'],
                    models: [
                      { name: 'claude-sonnet-4', alias: 'sonnet', 'display-name': 'Sonnet', 'max-context-length': 200_000 },
                      { name: 'claude-opus-4', alias: 'opus' },
                    ],
                  },
                ],
              },
            ],
          },
        });
      }
      return Response.json({ observed_at: '', files: [] });
    });

    const models = await client.credentials.modelsFor({ auth_index: 'cfg-claude' });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'sonnet',
      display_name: 'Sonnet',
      owned_by: 'anthropic',
      type: 'claude',
      context_length: 200_000,
    });
    expect(calls.map((c) => c.url.pathname)).toEqual(['/v8/management/credentials', '/v8/management/config']);
  });

  it('merges config model details by upstream name and requests a channel once', async () => {
    const { client, calls } = mockClient((req) => {
      if (req.url.pathname === '/v8/management/config') {
        return Response.json({
          'config-version': 8,
          'api-keys': {
            claude: [
              {
                'base-url': 'https://claude.test',
                keys: [
                  {
                    'api-key': 'k',
                    auth_index: 'cfg-claude',
                    models: [{ name: 'claude-upstream', alias: 'friendly', 'display-name': 'Friendly' }],
                  },
                ],
              },
            ],
          },
        });
      }
      if (req.url.pathname === '/v8/management/routing/model-definitions/claude') {
        return Response.json({
          channel: 'claude',
          models: [
            {
              id: 'claude-upstream',
              object: 'model',
              created: 1,
              owned_by: 'anthropic',
              type: 'claude',
              display_name: 'Upstream Name',
              context_length: 500_000,
              max_completion_tokens: 64_000,
            },
          ],
        });
      }
      return Response.json({ observed_at: '', files: [] });
    });

    const models = await client.credentials.modelsFor({ auth_index: 'cfg-claude' }, { details: true });
    expect(models).toEqual([
      expect.objectContaining({
        id: 'friendly',
        display_name: 'Friendly',
        context_length: 500_000,
        max_completion_tokens: 64_000,
        owned_by: 'anthropic',
        type: 'claude',
      }),
    ]);
    expect(calls.filter((c) => c.url.pathname.includes('/model-definitions/'))).toHaveLength(1);
  });

  it('uses channel defaults for config keys and applies group exclusions', async () => {
    const { client, calls } = mockClient((req) => {
      if (req.url.pathname === '/v8/management/config') {
        return Response.json({
          'config-version': 8,
          'api-keys': {
            codex: [
              {
                'base-url': 'https://codex.test',
                'excluded-models': ['*codex*'],
                keys: [{ 'api-key': 'k', auth_index: 'cfg-codex' }],
              },
            ],
          },
        });
      }
      if (req.url.pathname === '/v8/management/routing/model-definitions/codex') {
        return Response.json({
          channel: 'codex',
          models: [
            { id: 'gpt-5', object: 'model', created: 1, owned_by: 'openai', type: 'openai', display_name: 'GPT-5' },
            { id: 'gpt-5-codex', object: 'model', created: 1, owned_by: 'openai', type: 'openai', display_name: 'GPT-5 Codex' },
            { id: 'gpt-5-mini', object: 'model', created: 1, owned_by: 'openai', type: 'openai', display_name: 'GPT-5 mini' },
          ],
        });
      }
      return Response.json({ observed_at: '', files: [] });
    });

    const models = await client.credentials.modelsFor({ auth_index: 'cfg-codex' }, { details: true });
    expect(models.map((model) => model.id)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(calls.filter((c) => c.url.pathname.includes('/model-definitions/'))).toHaveLength(1);
  });

  it('returns configured models for OpenAI-compatible config keys', async () => {
    const { client, calls } = mockClient((req) => {
      if (req.url.pathname === '/v8/management/config') {
        return Response.json({
          'config-version': 8,
          'api-keys': {
            'openai-compatibility': [
              {
                name: 'fake',
                'base-url': 'https://fake.test/v1',
                keys: [{ 'api-key': 'k', auth_index: 'cfg-openai' }],
                models: [{ name: 'fake-model', alias: 'fake', 'display-name': 'Fake', 'max-context-length': 1000, image: true }],
              },
            ],
          },
        });
      }
      return Response.json({ observed_at: '', files: [] });
    });

    const models = await client.credentials.modelsFor({ auth_index: 'cfg-openai' });
    expect(models).toEqual([
      expect.objectContaining({ id: 'fake', display_name: 'Fake', type: 'openai-image', owned_by: 'fake', context_length: 1000 }),
    ]);
    expect(calls.some((c) => c.url.pathname.includes('/model-definitions/'))).toBe(false);
  });

  it('enriches file credential models from model definitions only when asked', async () => {
    const { client, calls } = mockClient((req) => {
      if (req.url.pathname === '/v8/management/credentials/models') {
        return Response.json({ models: [{ id: 'claude-sonnet', display_name: 'Custom Sonnet' }, { id: 'custom-only' }] });
      }
      if (req.url.pathname === '/v8/management/routing/model-definitions/claude') {
        return Response.json({
          channel: 'claude',
          models: [
            {
              id: 'claude-sonnet',
              object: 'model',
              created: 1,
              owned_by: 'anthropic',
              type: 'claude',
              display_name: 'Static Sonnet',
              context_length: 200_000,
            },
          ],
        });
      }
      return Response.json({
        observed_at: '',
        files: [{ name: 'a.json', auth_index: 'file-1', provider: 'claude', type: 'claude', disabled: false, source: 'file' }],
      });
    });

    const basic = await client.credentials.modelsFor({ name: 'a.json' });
    expect(basic).toEqual([
      { id: 'claude-sonnet', object: 'model', created: 0, owned_by: 'claude', type: 'claude', display_name: 'Custom Sonnet' },
      { id: 'custom-only', object: 'model', created: 0, owned_by: 'claude', type: 'claude' },
    ]);
    expect(calls.some((c) => c.url.pathname.includes('/model-definitions/'))).toBe(false);

    const detailed = await client.credentials.modelsFor({ name: 'a.json' }, { details: true });
    expect(detailed[0]).toMatchObject({
      id: 'claude-sonnet',
      display_name: 'Custom Sonnet',
      context_length: 200_000,
      owned_by: 'anthropic',
      type: 'claude',
    });
    expect(detailed[1]).toMatchObject({ id: 'custom-only', owned_by: 'claude', type: 'claude' });
    expect(calls.filter((c) => c.url.pathname.includes('/model-definitions/'))).toHaveLength(1);
  });

  it('reports a missing credential for modelsFor', async () => {
    const { client } = mockClient((req) =>
      req.url.pathname === '/v8/management/config' ? Response.json({ 'config-version': 8 }) : Response.json({ observed_at: '', files: [] }),
    );
    await expect(client.credentials.modelsFor({ auth_index: 'missing' })).rejects.toThrow(/auth_index "missing" was not found/);
    await expect(client.credentials.modelsFor({ name: 'missing.json' })).rejects.toThrow(/Credential "missing.json" was not found/);
  });

  it('maps the remaining routes', async () => {
    const { client, calls } = mockClient((req) =>
      req.url.pathname.endsWith('/download') ? new Response('{"type":"codex"}', { headers: { 'Content-Type': 'application/json' } }) : Response.json({ status: 'ok' }),
    );
    await client.credentials.list({ page: 2, page_size: 10 });
    await client.credentials.deleteAll();
    await client.credentials.models('a.json');
    const blob = await client.credentials.download('a.json');
    await client.credentials.setStatus({ name: 'a.json', disabled: true });
    await client.credentials.patchFields({ name: 'a.json', priority: 3, 'metadata.x': 1 });
    await client.credentials.refresh({ auth_index: 'abc' });
    await client.credentials.refreshAll();
    await client.credentials.siwcStatus({ name: 'a.json' });
    expect(await blob.text()).toBe('{"type":"codex"}');
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /v8/management/credentials?page=2&page_size=10',
      'DELETE /v8/management/credentials?all=true',
      'GET /v8/management/credentials/models?name=a.json',
      'GET /v8/management/credentials/download?name=a.json',
      'PATCH /v8/management/credentials/status',
      'PATCH /v8/management/credentials/fields',
      'POST /v8/management/credentials/refresh',
      'POST /v8/management/credentials/refresh',
      'GET /v8/management/credentials/siwc/status?name=a.json',
    ]);
    expect(JSON.parse(calls[6]!.body)).toEqual({ auth_index: 'abc' });
    expect(JSON.parse(calls[7]!.body)).toEqual({ all: true });
  });
});

describe('oauth', () => {
  it('starts with POST, polls status and cancels', async () => {
    let polls = 0;
    const { client, calls } = mockClient((req) => {
      if (req.url.pathname.endsWith('/auth-url')) return Response.json({ status: 'ok', url: 'https://login', state: 's1' });
      if (req.url.pathname.endsWith('/status')) return Response.json(++polls < 3 ? { status: 'wait' } : { status: 'ok' });
      return Response.json({ status: 'ok', cancelled: true });
    });
    const started = await client.oauth.start({ provider: 'claude', proxy_url: 'http://proxy:8080' });
    expect(started.state).toBe('s1');
    expect(JSON.parse(calls[0]!.body)).toEqual({ provider: 'claude', proxy_url: 'http://proxy:8080' });
    await expect(client.oauth.waitForCompletion('s1', { intervalMs: 1 })).resolves.toEqual({ status: 'ok' });
    expect(polls).toBe(3);
    await client.oauth.cancel('s1');
    expect(calls.at(-1)!.method).toBe('DELETE');
    expect(calls.at(-1)!.url.search).toBe('?state=s1');
  });

  it('sends the callback without the management key', async () => {
    const { client, calls } = mockClient();
    await client.oauth.callback({ redirect_url: 'http://localhost:54545/callback?code=c&state=s' });
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    expect(calls[0]!.url.pathname).toBe('/v8/management/oauth/callback');
  });

  it('imports a vertex service account as multipart field "file"', async () => {
    const { client, calls } = mockClient();
    await client.oauth.importVertex({ serviceAccount: { project_id: 'p' }, location: 'europe-west4' });
    expect(calls[0]!.url.search).toBe('?provider=vertex');
    const form = calls[0]!.formData!;
    expect(await (form.get('file') as File).text()).toBe('{"project_id":"p"}');
    expect(form.get('location')).toBe('europe-west4');
  });

  it('maps siwc routes', async () => {
    const { client, calls } = mockClient();
    await client.oauth.siwcBind('codex-a.json');
    await client.oauth.siwcStatus({ auth_index: 'abc' });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'POST /v8/management/oauth/siwc/bind',
      'GET /v8/management/oauth/siwc/status?auth_index=abc',
    ]);
  });
});

describe('ops resources', () => {
  it('maps logs, usage, routing, requests and plugins', async () => {
    const { client, calls } = mockClient((req) =>
      req.url.pathname.includes('/logs/errors/') || req.url.pathname.includes('/logs/requests/')
        ? new Response('log text', { headers: { 'Content-Disposition': 'attachment; filename="error-1.log"' } })
        : Response.json({}),
    );
    await client.logs.get({ cursor: 'c', limit: 10 });
    await client.logs.clear();
    await client.logs.listErrorLogs();
    const file = await client.logs.downloadErrorLog('error-1.log');
    await client.logs.downloadRequestLog('req-12345678');
    await client.usage.apiKeys();
    await client.usage.popQueue(5);
    await client.routing.resetCooldown('abc');
    await client.routing.modelDefinitions('claude');
    await client.requests.apiCall({ method: 'GET', url: 'https://example.com', header: { Authorization: 'Bearer $TOKEN$' } });
    await client.plugins.list();
    await client.plugins.delete('my-plugin');
    await client.plugins.store();
    await client.plugins.install('deepseek-search', { source: 'official' });
    await client.plugins.quota('p', 'abc');
    await client.plugins.resetQuota('p', 'abc');
    expect(file.filename).toBe('error-1.log');
    expect(await file.blob.text()).toBe('log text');
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /v8/management/observability/logs?cursor=c&limit=10',
      'DELETE /v8/management/observability/logs',
      'GET /v8/management/observability/logs/errors',
      'GET /v8/management/observability/logs/errors/error-1.log',
      'GET /v8/management/observability/logs/requests/req-12345678',
      'GET /v8/management/observability/usage/api-keys',
      'GET /v8/management/observability/usage/queue?count=5',
      'POST /v8/management/routing/cooldown/reset',
      'GET /v8/management/routing/model-definitions/claude',
      'POST /v8/management/requests/api-call',
      'GET /v8/management/plugins',
      'DELETE /v8/management/plugins/my-plugin',
      'GET /v8/management/plugins/store',
      'POST /v8/management/plugins/store/deepseek-search/install?source=official',
      'GET /v8/management/plugins/p/quota?auth_index=abc',
      'DELETE /v8/management/plugins/p/quota?auth_index=abc',
    ]);
    expect(JSON.parse(calls[7]!.body)).toEqual({ auth_index: 'abc' });
  });

  it('reads server info from headers, including on 404', async () => {
    const headers = { 'X-CPA-VERSION': '8.0.43', 'X-CPA-COMMIT': '3078035', 'X-CPA-BUILD-DATE': 'unknown', 'X-CPA-SUPPORT-PLUGIN': '1' };
    const found = mockClient(() => Response.json(8, { headers }));
    await expect(found.client.server.info()).resolves.toEqual({ version: '8.0.43', commit: '3078035', buildDate: 'unknown', supportPlugin: true });
    const missing = mockClient(() => Response.json({ error: 'not_found' }, { status: 404, headers }));
    await expect(missing.client.server.info()).resolves.toMatchObject({ version: '8.0.43' });
    const disabled = mockClient(() => new Response('', { status: 404 }));
    await expect(disabled.client.server.info()).rejects.toThrow(/X-CPA-VERSION/);
    const unauthorized = mockClient(() => Response.json({ error: 'invalid management key' }, { status: 401, headers }));
    await expect(unauthorized.client.server.info()).rejects.toBeInstanceOf(CpaHttpError);
  });

  it('health hits the root without a key; latestVersion unwraps the tag', async () => {
    const { client, calls } = mockClient((req) =>
      req.url.pathname.endsWith('/healthz') ? Response.json({ status: 'ok' }) : Response.json({ 'latest-version': 'v8.0.43' }),
    { baseUrl: 'http://cpa.test/prefix' });
    await expect(client.server.health()).resolves.toEqual({ status: 'ok' });
    await expect(client.server.latestVersion()).resolves.toBe('v8.0.43');
    expect(calls[0]!.url.pathname).toBe('/prefix/healthz');
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    expect(calls[1]!.url.pathname).toBe('/prefix/v8/management/server/latest-version');
  });
});

describe('apiCallJson', () => {
  const call = { method: 'GET', url: 'https://upstream.test/data', auth_index: 'abc' };

  it('returns status, headers and a parsed JSON body', async () => {
    const { client, calls } = mockClient(() =>
      Response.json({ status_code: 200, header: { 'X-Upstream': ['yes'] }, body: '{"ok":true,"value":1}' }),
    );
    const result = await client.requests.apiCallJson<{ ok: boolean; value: number }>(call);
    expect(result).toEqual({ status: 200, headers: { 'X-Upstream': ['yes'] }, data: { ok: true, value: 1 } });
    expect(calls[0]!.url.pathname).toBe('/v8/management/requests/api-call');
    expect(JSON.parse(calls[0]!.body)).toEqual(call);
  });

  it('throws CpaUpstreamError with the upstream status, headers and parsed body', async () => {
    const { client } = mockClient(() =>
      Response.json({ status_code: 401, header: { 'WWW-Authenticate': ['Bearer'] }, body: '{"error":"unauthorized"}' }),
    );
    const error = (await client.requests.apiCallJson(call).catch((e: unknown) => e)) as CpaUpstreamError;
    expect(error).toBeInstanceOf(CpaUpstreamError);
    expect(error.status).toBe(401);
    expect(error.headers).toEqual({ 'WWW-Authenticate': ['Bearer'] });
    expect(error.body).toEqual({ error: 'unauthorized' });
    expect(error.message).toContain('upstream 401');
  });

  it('throws CpaCredentialTokenError for CPA token-resolution failures', async () => {
    for (const code of ['auth token not found', 'auth credential not found for auth_index', 'auth token refresh failed']) {
      const { client } = mockClient(() => Response.json({ error: code }, { status: 400 }));
      const error = (await client.requests.apiCallJson(call).catch((e: unknown) => e)) as CpaCredentialTokenError;
      expect(error).toBeInstanceOf(CpaCredentialTokenError);
      expect(error.status).toBe(400);
      expect(error.errorCode).toBe(code);
      expect(error.cause).toBeInstanceOf(CpaHttpError);
    }
  });

  it('keeps other CPA errors as CpaHttpError', async () => {
    const { client } = mockClient(() => Response.json({ error: 'invalid url' }, { status: 400 }));
    const error = await client.requests.apiCallJson(call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CpaHttpError);
    expect(error).not.toBeInstanceOf(CpaCredentialTokenError);
  });

  it('throws CpaResponseError for a non-JSON 2xx body and returns undefined for an empty one', async () => {
    const plain = mockClient(() => Response.json({ status_code: 200, header: {}, body: 'pong' }));
    const error = (await plain.client.requests.apiCallJson(call).catch((e: unknown) => e)) as CpaResponseError;
    expect(error).toBeInstanceOf(CpaResponseError);
    expect(error.status).toBe(200);
    expect(error.body).toBe('pong');
    const quoted = mockClient(() => Response.json({ status_code: 200, header: {}, body: '"pong"' }));
    await expect(quoted.client.requests.apiCallJson(call)).resolves.toEqual({ status: 200, headers: {}, data: 'pong' });
    const empty = mockClient(() => Response.json({ status_code: 200, header: {}, body: '' }));
    await expect(empty.client.requests.apiCallJson(call)).resolves.toEqual({ status: 200, headers: {}, data: undefined });
  });

  it('leaves apiCall resolving on an upstream error', async () => {
    const { client } = mockClient(() => Response.json({ status_code: 401, header: {}, body: 'no' }));
    await expect(client.requests.apiCall(call)).resolves.toEqual({ status_code: 401, header: {}, body: 'no' });
  });
});
