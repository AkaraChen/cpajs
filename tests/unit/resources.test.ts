import { describe, expect, it } from 'vitest';
import { CpaHttpError, type CpaConfig } from '../../src/client/index.ts';
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

    expect(result).toEqual({ uploaded: ['chat-b.json', 'chat-c.json'], deleted: ['chat-stale.json'], unchanged: ['chat-a.json'] });
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

    expect(result).toEqual({ uploaded: [], deleted: [], unchanged: ['chat-a.json'] });
    expect(calls.filter((c) => c.url.pathname.endsWith('/download')).map((c) => c.url.searchParams.get('name'))).toEqual(['chat-a.json']);
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('refuses to overwrite a file owned by someone else', async () => {
    const { client, calls } = mockClient((req) =>
      req.url.pathname.endsWith('/download')
        ? Response.json({ type: 'claude', 'x-cpajs': { owner: 'other', revision: 'r1' } })
        : Response.json({ observed_at: '', files: [{ name: 'other.json', source: 'file' }] }),
    );

    await expect(
      client.credentials.reconcile({ owner: 'chat', files: [{ name: 'other.json', content: { type: 'claude' }, revision: 'r2' }] }),
    ).rejects.toThrow(/belongs to owner "other", not "chat"/);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('rejects duplicate file names before making requests', async () => {
    const { client, calls } = mockClient();
    const file = { name: 'chat-a.json', content: { type: 'claude' }, revision: 'r1' };
    await expect(client.credentials.reconcile({ owner: 'chat', files: [file, file] })).rejects.toThrow(/more than once/);
    expect(calls).toEqual([]);
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
