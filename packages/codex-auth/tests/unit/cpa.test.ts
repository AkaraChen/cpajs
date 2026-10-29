import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { CpaClient } from '@cpajs/cpa';
import { buildCpaAuthFile, parseIdToken, type CodexTokens } from '../../src/index.ts';
import { type CredentialUploader, loginAndUpload, uploadToCpa } from '../../src/cpa.ts';
import { fakeFetch, idToken, json, T0, tokenBody, URLS } from '../helpers.ts';

vi.mock('@cpajs/cpa', () => {
  throw new Error('@cpajs/cpa must not be imported at runtime');
});

function uploader() {
  const uploads: { file: { name: string; content: unknown }; options: unknown }[] = [];
  const client: CredentialUploader = {
    credentials: {
      async upload(file, options) {
        uploads.push({ file, options });
        return { status: 'ok' };
      },
    },
  };
  return { client, uploads };
}

function tokens(): CodexTokens {
  const id = idToken({ plan: 'pro' });
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    idToken: id,
    expiresAt: new Date(T0 + 3_600_000).toISOString(),
    expiresIn: 3600,
    claims: parseIdToken(id),
  };
}

describe('uploadToCpa', () => {
  it('uploads exactly what buildCpaAuthFile produces and forwards the signal', async () => {
    const { client, uploads } = uploader();
    const ctrl = new AbortController();
    const result = await uploadToCpa(client, tokens(), { now: () => T0, signal: ctrl.signal, extra: { prefix: 'p' } });
    const expected = buildCpaAuthFile(tokens(), { now: () => T0, extra: { prefix: 'p' } });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.file).toEqual(expected);
    expect(uploads[0]!.options).toEqual({ signal: ctrl.signal });
    expect(result).toEqual({ name: expected.name });
  });

  it('propagates upload rejections unchanged', async () => {
    const failure = new Error('upload failed');
    const client: CredentialUploader = {
      credentials: {
        upload: async () => {
          throw failure;
        },
      },
    };
    await expect(uploadToCpa(client, tokens())).rejects.toBe(failure);
  });
});

describe('loginAndUpload', () => {
  it('returns metadata only, never tokens', async () => {
    const f = fakeFetch();
    f.on(URLS.usercode, json({ device_auth_id: 'd', user_code: 'u' }));
    f.on(URLS.devicetoken, json({ authorization_code: 'ac', code_verifier: 'cv' }));
    f.on(URLS.token, json(tokenBody()));
    const { client, uploads } = uploader();
    const shown: string[] = [];
    const result = await loginAndUpload(client, { fetch: f.fetch, now: () => T0, onCode: (c) => void shown.push(c.userCode), build: { extra: { prefix: 'p' } } });
    expect(shown).toEqual(['u']);
    expect(result).toEqual({ name: uploads[0]!.file.name, email: 'user@example.com', accountId: 'acct-123', planType: 'plus' });
    expect(JSON.stringify(result)).not.toContain('test-access-token');
    expect(uploads[0]!.file.content).toMatchObject({ prefix: 'p', type: 'codex' });
  });
});

describe('types', () => {
  it('a real CpaClient satisfies CredentialUploader', () => {
    expectTypeOf<CpaClient>().toExtend<CredentialUploader>();
  });
});
