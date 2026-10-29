import { createHash } from 'node:crypto';
import { CodexIncompleteTokensError } from './errors.ts';
import { jwtExpiry, type CodexTokens } from './tokens.ts';

/**
 * Exact JSON CLIProxyAPI's CodexTokenStorage reads (internal/auth/codex/token.go, struct CodexTokenStorage).
 * `use_siwc` / `siwc` are CPA's Sign-in-with-ChatGPT sub-credential: never emitted here, preserved by parseCpaAuthFile.
 */
export interface CpaCodexAuthFile {
  type: 'codex';
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  email: string;
  /** RFC3339 UTC, seconds. */
  expired: string;
  /** RFC3339 UTC, seconds. */
  last_refresh: string;
  /** Defaults to 'free', like CPA's own writer. */
  plan_type: string;
  /** prefix, proxy_url, disabled, priority, note and caller metadata survive CPA's rewrites. */
  [extra: string]: unknown;
}

export interface BuildCpaAuthOptions {
  now?: () => number;
  /** Extra top-level keys (prefix, proxy_url, note, priority, disabled, app metadata). Reserved keys throw a TypeError. */
  extra?: Record<string, unknown>;
  /** Override the file name. Must end with .json and contain no path separators or "..". */
  name?: string;
}

const RESERVED_KEYS = [
  'type',
  'id_token',
  'access_token',
  'refresh_token',
  'account_id',
  'email',
  'expired',
  'last_refresh',
  'plan_type',
] as const;

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Port of CredentialFileName(email, plan, sha256(accountId)[:8], true): `codex[-hash]-email[-plan].json`.
 * The plan is lowercased and split on non-alphanumerics; an empty plan becomes 'free' (CPA's default for tokens
 * without the claim).
 */
export function cpaCodexFileName(input: { email: string; planType?: string; accountId?: string }): string {
  const email = input.email.trim();
  const plan =
    (input.planType ?? '')
      .trim()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .map((part) => part.toLowerCase())
      .join('-') || 'free';
  const accountId = (input.accountId ?? '').trim();
  const hash = accountId ? createHash('sha256').update(accountId).digest('hex').slice(0, 8) : '';
  return `${['codex', hash, email, plan].filter(Boolean).join('-')}.json`;
}

function validateName(name: string): void {
  if (!name.endsWith('.json') || name.length <= '.json'.length) throw new TypeError('Auth file name must end with .json.');
  // Same rule as CPA's upload handler (isUnsafeAuthFileName in
  // internal/api/handlers/management/auth_files.go): no path separators and no
  // drive prefix. ".." inside a flat name such as first..last@example.com is fine.
  if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) throw new TypeError('Auth file name must not contain path separators or a drive prefix.');
}

/** Throws CodexIncompleteTokensError if there is no email, access_token or refresh_token. */
export function buildCpaAuthFile(tokens: CodexTokens, options: BuildCpaAuthOptions = {}): { name: string; content: CpaCodexAuthFile } {
  const email = tokens.claims.email.trim();
  const required: [name: string, value: string][] = [
    ['email', email],
    ['access_token', tokens.accessToken],
    ['refresh_token', tokens.refreshToken],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new CodexIncompleteTokensError(`Cannot build a CPA auth file: missing ${missing.join(', ')}.`, missing);

  const extra = options.extra ?? {};
  const clash = RESERVED_KEYS.filter((key) => key in extra);
  if (clash.length) throw new TypeError(`extra cannot set reserved auth file keys: ${clash.join(', ')}.`);

  const now = (options.now ?? Date.now)();
  // CPA prefers the access token's own exp claim, so when the endpoint gave no expires_in fall back to it.
  const expiryMs = tokens.expiresIn > 0 ? Date.parse(tokens.expiresAt) : (jwtExpiry(tokens.accessToken)?.getTime() ?? Date.parse(tokens.expiresAt));
  const planType = tokens.claims.planType.trim() || 'free';

  const name = options.name ?? cpaCodexFileName({ email, planType, accountId: tokens.claims.accountId });
  validateName(name);

  return {
    name,
    content: {
      ...extra,
      type: 'codex',
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: tokens.claims.accountId,
      email,
      expired: isoSeconds(Number.isFinite(expiryMs) ? expiryMs : now),
      last_refresh: isoSeconds(now),
      plan_type: planType,
    },
  };
}

/** Reads a file CPA wrote earlier, preserving unknown keys (siwc, use_siwc, prefix, ...). Validates type === 'codex'. */
export function parseCpaAuthFile(json: string | Record<string, unknown>): CpaCodexAuthFile {
  const value: unknown = typeof json === 'string' ? JSON.parse(json) : json;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Auth file must be a JSON object.');
  const record = value as Record<string, unknown>;
  if (record.type !== 'codex') throw new TypeError(`Auth file type must be "codex", got ${JSON.stringify(record.type)}.`);
  return { ...record } as CpaCodexAuthFile;
}
