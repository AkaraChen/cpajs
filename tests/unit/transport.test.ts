import { describe, expect, it } from 'vitest';
import {
  CpaAbortError,
  CpaHttpError,
  CpaNetworkError,
  CpaResponseError,
  CpaTimeoutError,
  createClient,
  modelApiBaseUrl,
} from '../../src/client/index.ts';
import { encodePath } from '../../src/client/transport.ts';
import { mockClient } from './helpers.ts';

function never(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

describe('transport', () => {
  it('sends the management key as a bearer token and keeps a base path prefix', async () => {
    const { client, calls } = mockClient(() => Response.json({ files: [], observed_at: 'x' }), {
      baseUrl: 'https://proxy.example.com/cpa/',
    });
    await client.credentials.list();
    expect(calls[0]!.url.toString()).toBe('https://proxy.example.com/cpa/v8/management/credentials');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer mgmt-key');
    expect(calls[0]!.headers.get('accept')).toBe('application/json');
  });

  it('merges default and per-request headers, per-request winning', async () => {
    const { client, calls } = mockClient(() => Response.json({}), { headers: { 'X-A': '1', 'X-B': '1' } });
    await client.plugins.list({ headers: { 'X-B': '2' } });
    expect(calls[0]!.headers.get('x-a')).toBe('1');
    expect(calls[0]!.headers.get('x-b')).toBe('2');
  });

  it('encodes query values, skips undefined and repeats arrays', async () => {
    const { client, calls } = mockClient(() => Response.json({ status: 'ok' }));
    await client.credentials.delete(['a b.json', 'c&d.json']);
    expect(calls[0]!.url.search).toBe('?name=a+b.json&name=c%26d.json');
    await client.usage.popQueue();
    expect(calls[1]!.url.search).toBe('');
  });

  it('serialises JSON bodies, including strings and null', async () => {
    const { client, calls } = mockClient(() => Response.json({ status: 'ok', 'config-version': 8 }));
    await client.config.set('routing/strategy', 'fill-first');
    await client.config.set(['routing', 'strategy'], null);
    expect(calls[0]!.body).toBe('"fill-first"');
    expect(calls[0]!.contentType).toBe('application/json');
    expect(calls[1]!.body).toBe('null');
  });

  it('returns undefined for empty JSON bodies', async () => {
    const { client } = mockClient(() => new Response(null, { status: 200 }));
    const res = await client.request({ method: 'GET', path: '/anything' });
    expect(res.data).toBeUndefined();
  });

  it('throws CpaHttpError with status, raw body and CPA error fields', async () => {
    const { client } = mockClient(() =>
      Response.json({ error: 'invalid_config', message: 'unknown v8 configuration section bogus' }, { status: 400 }),
    );
    const error = await client.config.patch({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CpaHttpError);
    const http = error as CpaHttpError;
    expect(http.status).toBe(400);
    expect(http.errorCode).toBe('invalid_config');
    expect(http.errorMessage).toBe('unknown v8 configuration section bogus');
    expect(http.body).toContain('bogus');
    expect(http.message).toContain('400');
  });

  it('keeps non-JSON error bodies as text', async () => {
    const { client } = mockClient(() => new Response('', { status: 404, statusText: 'Not Found' }));
    const error = (await client.plugins.list().catch((e: unknown) => e)) as CpaHttpError;
    expect(error.status).toBe(404);
    expect(error.data).toBeUndefined();
    expect(error.body).toBe('');
  });

  it('treats 207 partial results as success', async () => {
    const body = { status: 'partial', uploaded: 1, files: ['a.json'], failed: [{ name: 'b.json', error: 'bad' }] };
    const { client } = mockClient(() => Response.json(body, { status: 207 }));
    await expect(client.credentials.uploadMany([{ name: 'a.json', content: {} }])).resolves.toEqual(body);
  });

  it('rejects invalid JSON in a 2xx response with CpaResponseError', async () => {
    const { client } = mockClient(() => new Response('{nope', { status: 200 }));
    await expect(client.plugins.list()).rejects.toBeInstanceOf(CpaResponseError);
  });

  it('distinguishes network errors, timeouts and caller aborts', async () => {
    const failing = createClient({
      baseUrl: 'http://cpa.test',
      managementKey: 'k',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(failing.plugins.list()).rejects.toBeInstanceOf(CpaNetworkError);

    const hanging = createClient({ baseUrl: 'http://cpa.test', managementKey: 'k', timeoutMs: 20, fetch: (req) => never(req.signal) });
    const timeout = await hanging.plugins.list().catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(CpaTimeoutError);
    expect((timeout as CpaTimeoutError).timeoutMs).toBe(20);

    // A per-request timeout overrides the default, and 0 disables it.
    const controller = new AbortController();
    const pending = hanging.plugins.list({ signal: controller.signal, timeoutMs: 0 });
    setTimeout(() => controller.abort(new Error('user cancelled')), 40);
    const aborted = await pending.catch((e: unknown) => e);
    expect(aborted).toBeInstanceOf(CpaAbortError);
    expect((aborted as CpaAbortError).cause).toEqual(new Error('user cancelled'));
  });

  it('fails fast on an already-aborted signal', async () => {
    const { client, calls } = mockClient();
    await expect(client.plugins.list({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CpaAbortError);
    expect(calls).toHaveLength(0);
  });

  it('keeps client instances independent', async () => {
    const a = mockClient(() => Response.json({}), { baseUrl: 'http://a.test' });
    const b = mockClient(() => Response.json({}), { baseUrl: 'http://b.test' });
    await a.client.plugins.list();
    await b.client.plugins.list();
    expect(a.calls.map((c) => c.url.host)).toEqual(['a.test']);
    expect(b.calls.map((c) => c.url.host)).toEqual(['b.test']);
  });

  it('validates options', () => {
    expect(() => createClient({ baseUrl: '', managementKey: 'k' })).toThrow(/baseUrl/);
    expect(() => createClient({ baseUrl: 'http://x', managementKey: '' })).toThrow(/managementKey/);
    expect(() => createClient({ baseUrl: 'ftp://x', managementKey: 'k' })).toThrow(/http/);
  });

  it('builds the model API base URL', () => {
    expect(modelApiBaseUrl('http://127.0.0.1:8317')).toBe('http://127.0.0.1:8317/v1');
    expect(modelApiBaseUrl('https://example.com/cpa/')).toBe('https://example.com/cpa/v1');
    expect(createClient({ baseUrl: 'http://h:1/p', managementKey: 'k' }).modelBaseUrl).toBe('http://h:1/p/v1');
  });

  it('encodes path segments', () => {
    expect(encodePath('routing/retry/request-retry')).toBe('routing/retry/request-retry');
    expect(encodePath(['plugins', 'configs', 'a b'])).toBe('plugins/configs/a%20b');
    expect(encodePath('/server/port/')).toBe('server/port');
    expect(() => encodePath('a//b')).toThrow(/empty segment/);
    expect(() => encodePath(['a/b'])).toThrow(/cannot address/);
  });
});
