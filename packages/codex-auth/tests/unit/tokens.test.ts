import { describe, expect, it } from 'vitest';
import {
  CodexHttpError,
  CodexIdTokenError,
  CodexIncompleteTokensError,
  CodexProtocolError,
  CodexRefreshReusedError,
  exchangeDeviceGrant,
  jwtExpiry,
  parseIdToken,
  refreshTokens,
} from '../../src/index.ts';
import { b64url, fakeFetch, idToken, json, jwt, T0, text, tokenBody, URLS } from '../helpers.ts';

describe('parseIdToken / jwtExpiry', () => {
  it('extracts the claims', () => {
    const claims = parseIdToken(
      jwt({
        email: 'user@example.com',
        exp: 1_800_000_000,
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct-1',
          chatgpt_plan_type: ' plus ',
          chatgpt_user_id: 'user-1',
          organizations: [{ id: 'org-1', title: 'Personal', role: 'owner', is_default: true }],
        },
      }),
    );
    expect(claims).toMatchObject({
      email: 'user@example.com',
      accountId: 'acct-1',
      planType: 'plus',
      userId: 'user-1',
      exp: 1_800_000_000,
      organizations: [{ id: 'org-1', title: 'Personal', role: 'owner', isDefault: true }],
    });
    expect(claims.raw.email).toBe('user@example.com');
  });

  it('gives empty strings without the auth block and does not default the plan', () => {
    const claims = parseIdToken(jwt({ email: 'a@b.c' }));
    expect(claims).toMatchObject({ accountId: '', planType: '' });
    expect(claims.userId).toBeUndefined();
  });

  it('decodes padded, unpadded and unicode payloads', () => {
    let payload = JSON.stringify({ email: 'üser@exämple.com' });
    while (!Buffer.from(payload).toString('base64').endsWith('=')) payload += ' ';
    const padded = Buffer.from(payload).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(padded.endsWith('=')).toBe(true);
    expect(parseIdToken(`h.${padded}.s`).email).toBe('üser@exämple.com');
    expect(parseIdToken(`h.${b64url(payload)}.s`).email).toBe('üser@exämple.com');
  });

  it('throws CodexIdTokenError for malformed input', () => {
    for (const bad of ['a.b', 'a.b.c.d', `h.${b64url('not json')}.s`, `h.${b64url('[1]')}.s`, '']) {
      expect(() => parseIdToken(bad)).toThrow(CodexIdTokenError);
    }
  });

  it('jwtExpiry returns the exp claim as a Date, undefined otherwise', () => {
    expect(jwtExpiry(jwt({ exp: 1_800_000_000 }))).toEqual(new Date(1_800_000_000_000));
    expect(jwtExpiry(jwt({}))).toBeUndefined();
    expect(jwtExpiry('opaque-token')).toBeUndefined();
    expect(jwtExpiry(`h.${b64url('nope')}.s`)).toBeUndefined();
  });
});

describe('exchangeDeviceGrant', () => {
  const grant = { authorizationCode: 'ac-1', codeVerifier: 'cv-1' };

  it('posts the exact form and builds tokens', async () => {
    const f = fakeFetch();
    f.on(URLS.token, json(tokenBody()));
    const tokens = await exchangeDeviceGrant(grant, { fetch: f.fetch, now: () => T0 });
    const call = f.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.headers.accept).toBe('application/json');
    expect(call.body).toBe(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        code: 'ac-1',
        redirect_uri: 'https://auth.openai.com/deviceauth/callback',
        code_verifier: 'cv-1',
      }).toString(),
    );
    expect(tokens.accessToken).toBe('test-access-token');
    expect(tokens.refreshToken).toBe('test-refresh-token');
    expect(tokens.expiresIn).toBe(3600);
    expect(tokens.expiresAt).toBe(new Date(T0 + 3_600_000).toISOString());
    expect(tokens.claims.planType).toBe('plus');
  });

  it('reports expiresIn 0 when the field is absent', async () => {
    const f = fakeFetch();
    f.on(URLS.token, json(tokenBody({ expires_in: undefined })));
    expect((await exchangeDeviceGrant(grant, { fetch: f.fetch, now: () => T0 })).expiresIn).toBe(0);
  });

  it('maps a non-OK answer to CodexHttpError(step exchange) and redacts tokens from the excerpt', async () => {
    const f = fakeFetch();
    const leaked = jwt({ email: 'x@y.z' });
    f.on(URLS.token, text(JSON.stringify({ error: 'invalid_grant', refresh_token: 'test-refresh-token', id_token: leaked, note: leaked }), 400));
    const error = (await exchangeDeviceGrant(grant, { fetch: f.fetch }).catch((e) => e)) as CodexHttpError;
    expect(error).toBeInstanceOf(CodexHttpError);
    expect(error.step).toBe('exchange');
    expect(error.status).toBe(400);
    const dumped = JSON.stringify(error) + error.message + error.bodyExcerpt;
    expect(dumped).not.toContain('test-refresh-token');
    expect(dumped).not.toContain(leaked);
    expect(dumped).toContain('invalid_grant');
  });

  it('throws CodexIncompleteTokensError for missing tokens or email', async () => {
    for (const [body, missing] of [
      [tokenBody({ refresh_token: undefined }), ['refresh_token']],
      [tokenBody({ access_token: undefined }), ['access_token']],
      [tokenBody({ id_token: undefined }), ['id_token']],
      [tokenBody({ id_token: idToken({ email: null }) }), ['email']],
    ] as const) {
      const f = fakeFetch();
      f.on(URLS.token, json(body));
      const error = await exchangeDeviceGrant(grant, { fetch: f.fetch }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CodexIncompleteTokensError);
      expect((error as CodexIncompleteTokensError).missing).toEqual(missing);
    }
  });

  it('accepts a plain function as fetch', async () => {
    const plain = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => json(tokenBody());
    await expect(exchangeDeviceGrant(grant, { fetch: plain })).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it('throws CodexIdTokenError for a malformed id_token and CodexProtocolError for a non-JSON body', async () => {
    const f = fakeFetch();
    f.on(URLS.token, json(tokenBody({ id_token: 'not-a-jwt' })));
    await expect(exchangeDeviceGrant(grant, { fetch: f.fetch })).rejects.toBeInstanceOf(CodexIdTokenError);
    const g = fakeFetch();
    g.on(URLS.token, text('ok', 200));
    await expect(exchangeDeviceGrant(grant, { fetch: g.fetch })).rejects.toBeInstanceOf(CodexProtocolError);
  });
});

describe('refreshTokens', () => {
  it('posts the refresh form and returns new tokens', async () => {
    const f = fakeFetch();
    f.on(URLS.token, json(tokenBody({ refresh_token: 'test-refresh-2' })));
    const tokens = await refreshTokens('test-refresh-token', { fetch: f.fetch, now: () => T0 });
    expect(f.calls[0]!.body).toBe(
      new URLSearchParams({
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'test-refresh-token',
        scope: 'openid profile email',
      }).toString(),
    );
    expect(tokens.refreshToken).toBe('test-refresh-2');
  });

  it('keeps the old refresh token when the response omits one', async () => {
    const f = fakeFetch();
    f.on(URLS.token, json(tokenBody({ refresh_token: undefined })));
    expect((await refreshTokens('test-refresh-token', { fetch: f.fetch })).refreshToken).toBe('test-refresh-token');
  });

  it('does not retry by default', async () => {
    const f = fakeFetch();
    f.on(URLS.token, text('x', 500));
    await expect(refreshTokens('t', { fetch: f.fetch })).rejects.toBeInstanceOf(CodexHttpError);
    expect(f.calls).toHaveLength(1);
  });

  it('retries with 1 s then 2 s backoff', async () => {
    const f = fakeFetch();
    f.on(URLS.token, text('x', 500), text('x', 500), json(tokenBody()));
    const sleeps: number[] = [];
    await refreshTokens('t', {
      fetch: f.fetch,
      retries: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([1000, 2000]);
    expect(f.calls).toHaveLength(3);
  });

  it('never retries refresh_token_reused', async () => {
    const f = fakeFetch();
    f.on(URLS.token, text('{"error":{"code":"refresh_token_reused"}}', 401));
    const error = await refreshTokens('t', { fetch: f.fetch, retries: 3, sleep: async () => {} }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexRefreshReusedError);
    expect(error).toBeInstanceOf(CodexHttpError);
    expect(error.step).toBe('refresh');
    expect(f.calls).toHaveLength(1);
  });

  it('rejects an empty refresh token with TypeError', async () => {
    await expect(refreshTokens('  ')).rejects.toBeInstanceOf(TypeError);
  });
});
