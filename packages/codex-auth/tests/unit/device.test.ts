import { describe, expect, it } from 'vitest';
import {
  CodexAbortError,
  CodexAuthError,
  CodexDeviceTimeoutError,
  CodexDeviceUnavailableError,
  CodexHttpError,
  CodexNetworkError,
  CodexProtocolError,
  completeDeviceAuth,
  type DeviceCode,
  loginWithDeviceCode,
  pollDeviceAuth,
  startDeviceAuth,
} from '../../src/index.ts';
import { fakeFetch, json, T0, text, tokenBody, URLS } from '../helpers.ts';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

describe('startDeviceAuth', () => {
  it('sends the documented request and returns the code', async () => {
    const f = fakeFetch();
    f.on(URLS.usercode, json({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '3' }));
    const code = await startDeviceAuth({ fetch: f.fetch, now: () => T0 });
    const call = f.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers.accept).toBe('application/json');
    expect(call.body).toBe(JSON.stringify({ client_id: CLIENT_ID }));
    expect(code).toEqual({
      deviceAuthId: 'dev-1',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
      intervalSeconds: 3,
      expiresAt: new Date(T0 + 15 * 60_000).toISOString(),
    });
  });

  it('accepts the usercode spelling and trims', async () => {
    const f = fakeFetch();
    f.on(URLS.usercode, json({ device_auth_id: ' dev ', usercode: '  WXYZ ' }));
    const code = await startDeviceAuth({ fetch: f.fetch });
    expect(code.userCode).toBe('WXYZ');
    expect(code.deviceAuthId).toBe('dev');
  });

  it.each([
    ['"3"', '3', 3],
    ['7', 7, 7],
    ['missing', undefined, 5],
    ['zero', 0, 5],
    ['negative', -4, 5],
    ['garbage', 'soon', 5],
    ['below one', 0.2, 1],
  ])('parses interval %s', async (_label, interval, expected) => {
    const f = fakeFetch();
    f.on(URLS.usercode, json({ device_auth_id: 'd', user_code: 'u', interval }));
    expect((await startDeviceAuth({ fetch: f.fetch })).intervalSeconds).toBe(expected);
  });

  it('maps 404 to CodexDeviceUnavailableError', async () => {
    const f = fakeFetch();
    f.on(URLS.usercode, text('nope', 404));
    const error = await startDeviceAuth({ fetch: f.fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexDeviceUnavailableError);
    expect(error).toBeInstanceOf(CodexHttpError);
    expect(error.status).toBe(404);
  });

  it('truncates the body excerpt of a 500 to 300 characters', async () => {
    const f = fakeFetch();
    f.on(URLS.usercode, text('x'.repeat(1000), 500));
    const error = (await startDeviceAuth({ fetch: f.fetch }).catch((e) => e)) as CodexHttpError;
    expect(error).toBeInstanceOf(CodexHttpError);
    expect(error.status).toBe(500);
    expect(error.step).toBe('usercode');
    expect(error.bodyExcerpt).toHaveLength(300);
  });

  it('rejects missing fields and non-JSON bodies with CodexProtocolError', async () => {
    for (const res of [json({ device_auth_id: 'd' }), json({ user_code: 'u' }), json({ device_auth_id: ' ', user_code: 'u' }), text('<html>', 200)]) {
      const f = fakeFetch();
      f.on(URLS.usercode, res);
      await expect(startDeviceAuth({ fetch: f.fetch })).rejects.toBeInstanceOf(CodexProtocolError);
    }
  });

  it('wraps fetch failures in CodexNetworkError', async () => {
    const f = fakeFetch();
    f.on(URLS.usercode, new Error('ECONNRESET'));
    const error = await startDeviceAuth({ fetch: f.fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexNetworkError);
    expect((error as CodexNetworkError).cause).toBeInstanceOf(Error);
  });

  it('honours a custom issuer (trailing slash trimmed) and clientId', async () => {
    const f = fakeFetch();
    f.on('https://issuer.test/api/accounts/deviceauth/usercode', json({ device_auth_id: 'd', user_code: 'u' }));
    await startDeviceAuth({ fetch: f.fetch, issuer: 'https://issuer.test/', clientId: 'client-x' });
    expect(f.calls[0]!.body).toBe('{"client_id":"client-x"}');
  });

  it('aborts a hung fetch after requestTimeoutMs', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    await expect(startDeviceAuth({ fetch: hang, requestTimeoutMs: 20 })).rejects.toBeInstanceOf(CodexNetworkError);
  });

  it('rejects before any request when the signal is already aborted', async () => {
    const f = fakeFetch();
    const error = await startDeviceAuth({ fetch: f.fetch, signal: AbortSignal.abort() }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAbortError);
    expect(f.calls).toHaveLength(0);
  });
});

describe('pollDeviceAuth', () => {
  const code = { deviceAuthId: 'dev-1', userCode: 'ABCD' };

  it('sends device_auth_id and user_code', async () => {
    const f = fakeFetch();
    f.on(URLS.devicetoken, json({ authorization_code: 'ac', code_verifier: 'cv', code_challenge: 'cc' }));
    const result = await pollDeviceAuth(code, { fetch: f.fetch });
    expect(f.calls[0]!.body).toBe(JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD' }));
    expect(f.calls[0]!.headers['content-type']).toBe('application/json');
    expect(result).toEqual({ status: 'approved', grant: { authorizationCode: 'ac', codeVerifier: 'cv' } });
  });

  it('works without code_challenge', async () => {
    const f = fakeFetch();
    f.on(URLS.devicetoken, json({ authorization_code: 'ac', code_verifier: 'cv' }));
    expect((await pollDeviceAuth(code, { fetch: f.fetch })).status).toBe('approved');
  });

  it.each([403, 404])('treats %i as pending', async (status) => {
    const f = fakeFetch();
    f.on(URLS.devicetoken, text('', status));
    expect(await pollDeviceAuth(code, { fetch: f.fetch })).toEqual({ status: 'pending' });
  });

  it('rejects a 200 without the grant fields', async () => {
    for (const body of [{ code_verifier: 'cv' }, { authorization_code: 'ac' }, {}]) {
      const f = fakeFetch();
      f.on(URLS.devicetoken, json(body));
      await expect(pollDeviceAuth(code, { fetch: f.fetch })).rejects.toBeInstanceOf(CodexProtocolError);
    }
  });

  it.each([500, 401, 400])('fails on HTTP %i with step devicetoken', async (status) => {
    const f = fakeFetch();
    f.on(URLS.devicetoken, text('boom', status));
    const error = (await pollDeviceAuth(code, { fetch: f.fetch }).catch((e) => e)) as CodexHttpError;
    expect(error).toBeInstanceOf(CodexHttpError);
    expect(error.step).toBe('devicetoken');
    expect(error.status).toBe(status);
  });

  it('handles the defensive RFC 8628 errors', async () => {
    const f = fakeFetch();
    f.on(URLS.devicetoken, json({ error: 'slow_down' }, 400), json({ error: 'authorization_pending' }, 400));
    expect(await pollDeviceAuth(code, { fetch: f.fetch })).toEqual({ status: 'pending', slowDown: true });
    expect(await pollDeviceAuth(code, { fetch: f.fetch })).toEqual({ status: 'pending' });

    const g = fakeFetch();
    g.on(URLS.devicetoken, json({ error: 'expired_token' }, 400));
    await expect(pollDeviceAuth(code, { fetch: g.fetch })).rejects.toBeInstanceOf(CodexDeviceTimeoutError);

    const h = fakeFetch();
    h.on(URLS.devicetoken, json({ error: 'access_denied' }, 400));
    const denied = (await pollDeviceAuth(code, { fetch: h.fetch }).catch((e) => e)) as CodexHttpError;
    expect(denied).toBeInstanceOf(CodexHttpError);
    expect(denied.code).toBe('access_denied');
  });
});

describe('completeDeviceAuth / loginWithDeviceCode', () => {
  const deviceCode = (over: Partial<DeviceCode> = {}): DeviceCode => ({
    deviceAuthId: 'dev-1',
    userCode: 'ABCD',
    verificationUrl: 'https://auth.openai.com/codex/device',
    intervalSeconds: 5,
    expiresAt: new Date(T0 + 15 * 60_000).toISOString(),
    ...over,
  });
  const approved = json({ authorization_code: 'ac', code_verifier: 'cv' });

  function setup() {
    const f = fakeFetch();
    const sleeps: number[] = [];
    let clock = T0;
    return {
      f,
      sleeps,
      advance: (ms: number) => (clock += ms),
      opts: {
        fetch: f.fetch,
        now: () => clock,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    };
  }

  it('polls pending, pending, approved then exchanges once, with no initial sleep', async () => {
    const { f, sleeps, opts } = setup();
    f.on(URLS.devicetoken, text('', 403), text('', 404), approved);
    f.on(URLS.token, json(tokenBody()));
    const polls: number[] = [];
    const tokens = await completeDeviceAuth(deviceCode(), { ...opts, onPoll: (i) => polls.push(i.attempt) });
    expect(sleeps).toEqual([5000, 5000]);
    expect(f.callsTo(URLS.devicetoken)).toHaveLength(3);
    expect(f.callsTo(URLS.token)).toHaveLength(1);
    expect(tokens.accessToken).toBe('test-access-token');
    expect(polls).toEqual([1, 2, 3]);
  });

  it('lets intervalSeconds override the server interval', async () => {
    const { f, sleeps, opts } = setup();
    f.on(URLS.devicetoken, text('', 403), approved);
    f.on(URLS.token, json(tokenBody()));
    await completeDeviceAuth(deviceCode({ intervalSeconds: 9 }), { ...opts, intervalSeconds: 2 });
    expect(sleeps).toEqual([2000]);
  });

  it('grows the interval by 5 s on each slow_down', async () => {
    const { f, sleeps, opts } = setup();
    f.on(URLS.devicetoken, json({ error: 'slow_down' }, 400), json({ error: 'slow_down' }, 429), text('', 403), approved);
    f.on(URLS.token, json(tokenBody()));
    await completeDeviceAuth(deviceCode({ intervalSeconds: 5 }), opts);
    expect(sleeps).toEqual([10_000, 15_000, 15_000]);
  });

  it('keeps polling on authorization_pending errors', async () => {
    const { f, sleeps, opts } = setup();
    f.on(URLS.devicetoken, json({ error: 'authorization_pending' }, 400), approved);
    f.on(URLS.token, json(tokenBody()));
    await completeDeviceAuth(deviceCode(), opts);
    expect(sleeps).toEqual([5000]);
  });

  it('retries a transient network error', async () => {
    const { f, sleeps, opts } = setup();
    f.on(URLS.devicetoken, new Error('ECONNRESET'), approved);
    f.on(URLS.token, json(tokenBody()));
    const seen: unknown[] = [];
    await completeDeviceAuth(deviceCode(), { ...opts, onPoll: (i) => seen.push(i.error) });
    expect(sleeps).toEqual([5000]);
    expect(seen[0]).toBeInstanceOf(CodexNetworkError);
  });

  it('fails with CodexNetworkError once maxNetworkErrors is exceeded', async () => {
    const { f, opts } = setup();
    f.on(URLS.devicetoken, new Error('down'));
    await expect(completeDeviceAuth(deviceCode(), { ...opts, maxNetworkErrors: 2 })).rejects.toBeInstanceOf(CodexNetworkError);
    expect(f.callsTo(URLS.devicetoken)).toHaveLength(3);
  });

  it('ends immediately on a non-403/404 error', async () => {
    const { f, opts } = setup();
    f.on(URLS.devicetoken, text('', 403), text('denied', 401), approved);
    const error = await completeDeviceAuth(deviceCode(), opts).catch((e) => e);
    expect(error).toBeInstanceOf(CodexHttpError);
    expect(f.callsTo(URLS.devicetoken)).toHaveLength(2);
  });

  it('times out at the deadline without another request', async () => {
    const { f, advance, opts } = setup();
    f.on(URLS.devicetoken, text('', 403));
    const sleep = async () => {
      advance(10 * 60_000);
    };
    const error = await completeDeviceAuth(deviceCode(), { ...opts, sleep }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexDeviceTimeoutError);
    expect(error.code).toBe('device_code_timeout');
    expect(f.callsTo(URLS.devicetoken)).toHaveLength(2);
  });

  it('honours an explicit deadline', async () => {
    const { f, opts } = setup();
    f.on(URLS.devicetoken, text('', 403));
    await expect(completeDeviceAuth(deviceCode(), { ...opts, deadline: T0 })).rejects.toBeInstanceOf(CodexDeviceTimeoutError);
    expect(f.calls).toHaveLength(0);
  });

  it('rejects with CodexAbortError before any request when already aborted', async () => {
    const { f, opts } = setup();
    await expect(completeDeviceAuth(deviceCode(), { ...opts, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CodexAbortError);
    expect(f.calls).toHaveLength(0);
  });

  it('rejects with CodexAbortError when aborted during sleep', async () => {
    const { f, opts } = setup();
    f.on(URLS.devicetoken, text('', 403));
    const ctrl = new AbortController();
    const sleep = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('sleep aborted')));
        queueMicrotask(() => ctrl.abort());
      });
    const error = await completeDeviceAuth(deviceCode(), { ...opts, sleep, signal: ctrl.signal }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAbortError);
  });

  it('rejects with CodexAbortError when aborted during a fetch', async () => {
    const ctrl = new AbortController();
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        queueMicrotask(() => ctrl.abort());
      })) as unknown as typeof fetch;
    const error = await completeDeviceAuth(deviceCode(), { fetch: hang, signal: ctrl.signal, now: () => T0 }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAbortError);
  });

  it('the default sleep rejects on abort', async () => {
    const f = fakeFetch();
    f.on(URLS.devicetoken, text('', 403));
    const ctrl = new AbortController();
    const promise = completeDeviceAuth(deviceCode(), { fetch: f.fetch, now: () => T0, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(promise).rejects.toBeInstanceOf(CodexAbortError);
  });

  it('loginWithDeviceCode shows the code before the first poll', async () => {
    const { f, opts } = setup();
    const order: string[] = [];
    f.on(URLS.usercode, () => {
      order.push('usercode');
      return json({ device_auth_id: 'd', user_code: 'u', interval: 1 });
    });
    f.on(URLS.devicetoken, () => {
      order.push('poll');
      return approved.clone();
    });
    f.on(URLS.token, json(tokenBody()));
    const tokens = await loginWithDeviceCode({
      ...opts,
      onCode: async (c) => {
        order.push(`code:${c.userCode}`);
      },
    });
    expect(order).toEqual(['usercode', 'code:u', 'poll']);
    expect(tokens.claims.email).toBe('user@example.com');
  });

  it('every error extends CodexAuthError with a code', async () => {
    const f = fakeFetch();
    f.on(URLS.usercode, text('x', 500));
    const error = await startDeviceAuth({ fetch: f.fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAuthError);
    expect(error.code).toBe('http_error');
  });
});
