import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCpaAuthFile,
  type CodexTokens,
  CodexIncompleteTokensError,
  cpaCodexFileName,
  parseCpaAuthFile,
  parseIdToken,
} from '../../src/index.ts';
import { idToken, T0 } from '../helpers.ts';

const hash8 = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 8);

function tokens(over: { plan?: string; accountId?: string; email?: string | null; expiresIn?: number; accessToken?: string } = {}): CodexTokens {
  const id = idToken({
    email: over.email === undefined ? 'user@example.com' : over.email,
    ...(over.plan === undefined ? {} : { plan: over.plan }),
    ...(over.accountId === undefined ? {} : { accountId: over.accountId }),
  });
  const expiresIn = over.expiresIn ?? 3600;
  return {
    accessToken: over.accessToken ?? 'test-access-token',
    refreshToken: 'test-refresh-token',
    idToken: id,
    expiresIn,
    expiresAt: new Date(T0 + expiresIn * 1000).toISOString(),
    claims: parseIdToken(id),
  };
}

describe('buildCpaAuthFile', () => {
  it('emits exactly the CodexTokenStorage fields (token.go) as RFC3339 UTC seconds', () => {
    const t = tokens({ plan: 'plus' });
    const { name, content } = buildCpaAuthFile(t, { now: () => T0 });
    // Golden fixture reproduced from the JSON tags of CodexTokenStorage in internal/auth/codex/token.go.
    expect(content).toEqual({
      type: 'codex',
      id_token: t.idToken,
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      account_id: 'acct-123',
      email: 'user@example.com',
      expired: '2026-10-25T01:00:00Z',
      last_refresh: '2026-10-25T00:00:00Z',
      plan_type: 'plus',
    });
    expect(Object.keys(content).sort()).toEqual(
      ['access_token', 'account_id', 'email', 'expired', 'id_token', 'last_refresh', 'plan_type', 'refresh_token', 'type'].sort(),
    );
    for (const v of Object.values(content)) expect(typeof v).toBe('string');
    expect(content.expired).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(content.last_refresh).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(name).toBe(`codex-${hash8('acct-123')}-user@example.com-plus.json`);
  });

  it('defaults plan_type to free and allows an empty account_id', () => {
    const { name, content } = buildCpaAuthFile(tokens({ accountId: '' }), { now: () => T0 });
    expect(content.plan_type).toBe('free');
    expect(content.account_id).toBe('');
    expect(name).toBe('codex-user@example.com-free.json');
  });

  it('falls back to the access token exp when expires_in is absent', () => {
    const access = `h.${Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString('base64url')}.s`;
    const { content } = buildCpaAuthFile(tokens({ expiresIn: 0, accessToken: access }), { now: () => T0 });
    expect(content.expired).toBe('2027-01-15T08:00:00Z');
  });

  it('merges extra keys and rejects reserved ones', () => {
    const { content } = buildCpaAuthFile(tokens(), {
      now: () => T0,
      extra: { prefix: 'team-a', proxy_url: 'http://proxy', note: 'n', chat_seed: 'seed' },
    });
    expect(content).toMatchObject({ prefix: 'team-a', proxy_url: 'http://proxy', note: 'n', chat_seed: 'seed', type: 'codex' });
    for (const key of ['type', 'email', 'access_token', 'refresh_token', 'plan_type', 'expired']) {
      expect(() => buildCpaAuthFile(tokens(), { extra: { [key]: 'x' } })).toThrow(TypeError);
    }
  });

  it('throws CodexIncompleteTokensError when email, access or refresh token is missing', () => {
    const missingOf = (fn: () => unknown): readonly string[] => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(CodexIncompleteTokensError);
        return (error as CodexIncompleteTokensError).missing;
      }
      throw new Error('expected CodexIncompleteTokensError');
    };
    expect(missingOf(() => buildCpaAuthFile({ ...tokens(), claims: { ...tokens().claims, email: '' } }))).toEqual(['email']);
    expect(missingOf(() => buildCpaAuthFile({ ...tokens(), accessToken: '' }))).toEqual(['access_token']);
    expect(missingOf(() => buildCpaAuthFile({ ...tokens(), accessToken: '', refreshToken: '' }))).toEqual(['access_token', 'refresh_token']);
  });

  it('validates the name override', () => {
    expect(buildCpaAuthFile(tokens(), { name: 'mine.json' }).name).toBe('mine.json');
    for (const bad of ['mine', 'a/b.json', 'a\\b.json', '../a.json', 'C:a.json', '.json']) {
      expect(() => buildCpaAuthFile(tokens(), { name: bad })).toThrow(TypeError);
    }
    // CPA only rejects separators and drive prefixes, so ".." inside a flat name is fine.
    expect(buildCpaAuthFile(tokens(), { name: 'x..y.json' }).name).toBe('x..y.json');
  });

  it('accepts an email with consecutive dots', () => {
    const t = tokens();
    const { name, content } = buildCpaAuthFile({ ...t, claims: { ...t.claims, email: 'first..last@example.com' } });
    expect(name).toContain('first..last@example.com');
    expect(content.email).toBe('first..last@example.com');
  });
});

describe('cpaCodexFileName (internal/auth/codex/filename_test.go)', () => {
  const email = 'user@example.com';
  it.each([
    [{ email, planType: 'team', accountId: 'abc' }, `codex-${hash8('abc')}-user@example.com-team.json`],
    [{ email, planType: 'k12' }, 'codex-user@example.com-k12.json'],
    [{ email, planType: 'plus' }, 'codex-user@example.com-plus.json'],
    [{ email, planType: 'Team Plan', accountId: 'abc' }, `codex-${hash8('abc')}-user@example.com-team-plan.json`],
    [{ email, planType: 'prolite' }, 'codex-user@example.com-prolite.json'],
    [{ email, planType: ' Team  Plus! ' }, 'codex-user@example.com-team-plus.json'],
    [{ email, accountId: 'abc' }, `codex-${hash8('abc')}-user@example.com-free.json`],
    [{ email }, 'codex-user@example.com-free.json'],
    [{ email: ' User+Tag@Example.com ', planType: '' }, 'codex-User+Tag@Example.com-free.json'],
  ])('%o -> %s', (input, expected) => {
    expect(cpaCodexFileName(input)).toBe(expected);
  });

  it('hashes with sha256 hex first 8', () => {
    expect(hash8('abc')).toBe('ba7816bf');
    expect(cpaCodexFileName({ email, accountId: 'abc' })).toContain('codex-ba7816bf-');
  });
});

describe('parseCpaAuthFile', () => {
  it('round-trips and keeps unknown keys including siwc', () => {
    const { content } = buildCpaAuthFile(tokens(), { now: () => T0, extra: { prefix: 'p' } });
    const withSiwc = { ...content, use_siwc: true, siwc: { access_token: 'test-siwc' } };
    expect(parseCpaAuthFile(JSON.stringify(content))).toEqual(content);
    expect(parseCpaAuthFile(JSON.stringify(withSiwc))).toEqual(withSiwc);
    expect(parseCpaAuthFile(withSiwc)).toEqual(withSiwc);
  });

  it('rejects non-codex and non-object input', () => {
    expect(() => parseCpaAuthFile({ type: 'claude' })).toThrow(TypeError);
    expect(() => parseCpaAuthFile('[]')).toThrow(TypeError);
    expect(() => parseCpaAuthFile('null')).toThrow(TypeError);
  });
});
