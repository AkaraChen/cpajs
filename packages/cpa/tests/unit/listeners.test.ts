// Regression tests: abort listeners must not accumulate on a reused signal.
import { describe, expect, it } from 'vitest';
import { CpaAbortError, CpaHttpError, CpaNetworkError, createClient } from '../../src/client/index.ts';
import { countingController, mockClient } from './helpers.ts';

describe('oauth.waitForCompletion', () => {
  it('leaves no abort listeners behind after many polls', async () => {
    let polls = 0;
    const { client } = mockClient(() => Response.json(++polls < 15 ? { status: 'wait' } : { status: 'ok' }));
    const { controller, listeners } = countingController();
    await expect(client.oauth.waitForCompletion('s', { intervalMs: 1, signal: controller.signal })).resolves.toEqual({ status: 'ok' });
    expect(polls).toBe(15);
    expect(listeners()).toBe(0);
  });

  it('rejects with CpaAbortError when cancelled between polls, during a request, or beforehand', async () => {
    const { client } = mockClient(() => Response.json({ status: 'wait' }));

    const between = countingController();
    const pending = client.oauth.waitForCompletion('s', { intervalMs: 60_000, signal: between.controller.signal });
    setTimeout(() => between.controller.abort(new Error('stop')), 20);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CpaAbortError);
    expect((error as CpaAbortError).cause).toEqual(new Error('stop'));
    expect(between.listeners()).toBe(0);

    const hanging = createClient({
      baseUrl: 'http://cpa.test',
      managementKey: 'k',
      fetch: (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason))),
    });
    const during = countingController();
    const inFlight = hanging.oauth.waitForCompletion('s', { signal: during.controller.signal });
    setTimeout(() => during.controller.abort(), 20);
    await expect(inFlight).rejects.toBeInstanceOf(CpaAbortError);
    expect(during.listeners()).toBe(0);

    await expect(client.oauth.waitForCompletion('s', { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CpaAbortError);
  });
});

describe('transport raw responses', () => {
  it('releases the caller signal listener when no Response is handed back', async () => {
    const httpError = mockClient(() => new Response('nope', { status: 500 }));
    const failing = countingController();
    await expect(
      httpError.client.request({ method: 'GET', path: '/x', responseType: 'response', signal: failing.controller.signal }),
    ).rejects.toBeInstanceOf(CpaHttpError);
    expect(failing.listeners()).toBe(0);

    const network = createClient({
      baseUrl: 'http://cpa.test',
      managementKey: 'k',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const offline = countingController();
    await expect(network.request({ method: 'GET', path: '/x', responseType: 'response', signal: offline.controller.signal })).rejects.toBeInstanceOf(
      CpaNetworkError,
    );
    expect(offline.listeners()).toBe(0);
  });

  it('keeps the caller signal able to cancel a handed-off body', async () => {
    const { client } = mockClient(() => new Response('body'));
    const reading = countingController();
    const res = await client.request<Response>({ method: 'GET', path: '/x', responseType: 'response', signal: reading.controller.signal });
    expect(reading.listeners()).toBe(1);
    expect(await res.data.text()).toBe('body');
  });

  it('releases listeners for every other response type', async () => {
    const { client } = mockClient(() => Response.json({}));
    const json = countingController();
    await client.plugins.list({ signal: json.controller.signal });
    expect(json.listeners()).toBe(0);
  });
});
