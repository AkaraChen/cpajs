import {
  CodexHttpError,
  CodexIdTokenError,
  CodexIncompleteTokensError,
  CodexProtocolError,
  CodexRefreshReusedError,
  excerpt,
} from './errors.ts';
import {
  CODEX_DEVICE_REDIRECT_URI,
  FORM_HEADERS,
  type CodexAuthOptions,
  defaultSleep,
  parseJsonObject,
  resolve,
  type ResolvedOptions,
  send,
  str,
  throwIfAborted,
} from './http.ts';
import type { DeviceGrant } from './device.ts';

export interface CodexIdTokenClaims {
  email: string;
  /** `https://api.openai.com/auth`.chatgpt_account_id, '' if absent. */
  accountId: string;
  /** chatgpt_plan_type trimmed; '' if absent (not defaulted here). */
  planType: string;
  userId?: string;
  organizations?: ReadonlyArray<{ id: string; title?: string; role?: string; isDefault?: boolean }>;
  /** Seconds since the epoch. */
  exp?: number;
  raw: Record<string, unknown>;
}

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** ISO string, now + expires_in. */
  expiresAt: string;
  /** Seconds from the token endpoint (0 if absent). */
  expiresIn: number;
  claims: CodexIdTokenClaims;
}

function decodePayload(segment: string): Record<string, unknown> | undefined {
  try {
    const text = Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return parseJsonObject(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Decodes the payload of an id_token without verifying the signature. */
export function parseIdToken(idToken: string): CodexIdTokenClaims {
  const parts = typeof idToken === 'string' ? idToken.split('.') : [];
  if (parts.length !== 3) throw new CodexIdTokenError('id_token is not a JWT: expected three dot-separated segments.');
  const raw = decodePayload(parts[1] ?? '');
  if (!raw) throw new CodexIdTokenError('id_token payload is not a base64url encoded JSON object.');

  const auth = isRecord(raw['https://api.openai.com/auth']) ? raw['https://api.openai.com/auth'] : {};
  const claims: CodexIdTokenClaims = {
    email: str(raw.email),
    accountId: str(auth.chatgpt_account_id),
    planType: str(auth.chatgpt_plan_type),
    raw,
  };
  const userId = str(auth.chatgpt_user_id) || str(auth.user_id);
  if (userId) claims.userId = userId;
  if (Array.isArray(auth.organizations)) {
    claims.organizations = auth.organizations.filter(isRecord).map((org) => {
      const out: { id: string; title?: string; role?: string; isDefault?: boolean } = { id: str(org.id) };
      if (typeof org.title === 'string') out.title = org.title;
      if (typeof org.role === 'string') out.role = org.role;
      if (typeof org.is_default === 'boolean') out.isDefault = org.is_default;
      return out;
    });
  }
  if (typeof raw.exp === 'number' && Number.isFinite(raw.exp)) claims.exp = raw.exp;
  return claims;
}

/** Expiry (`exp` claim) of any JWT, undefined if the value is not a JWT or carries no exp. */
export function jwtExpiry(token: string): Date | undefined {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return undefined;
  const payload = decodePayload(parts[1] ?? '');
  const exp = payload?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000) : undefined;
}

function tokensFromBody(body: Record<string, unknown>, opts: ResolvedOptions, fallbackRefreshToken?: string): CodexTokens {
  const accessToken = str(body.access_token);
  const refreshToken = str(body.refresh_token) || fallbackRefreshToken || '';
  const idToken = str(body.id_token);
  const missing = [
    ['access_token', accessToken],
    ['refresh_token', refreshToken],
    ['id_token', idToken],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new CodexIncompleteTokensError(`Token response is missing ${missing.join(', ')}.`);

  const claims = parseIdToken(idToken);
  if (!claims.email) throw new CodexIncompleteTokensError('id_token carries no email claim, which CLIProxyAPI requires.');

  const rawExpiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  const expiresIn = Number.isFinite(rawExpiresIn) && rawExpiresIn > 0 ? Math.floor(rawExpiresIn) : 0;
  return {
    accessToken,
    refreshToken,
    idToken,
    expiresAt: new Date(opts.now() + expiresIn * 1000).toISOString(),
    expiresIn,
    claims,
  };
}

async function tokenRequest(
  opts: ResolvedOptions,
  step: 'exchange' | 'refresh',
  form: Record<string, string>,
  fallbackRefreshToken?: string,
): Promise<CodexTokens> {
  const res = await send(opts, `${opts.issuer}/oauth/token`, { headers: { ...FORM_HEADERS }, body: new URLSearchParams(form).toString() });
  if (!res.ok) {
    if (step === 'refresh' && res.text.includes('refresh_token_reused')) throw new CodexRefreshReusedError(res.status, excerpt(res.text));
    throw new CodexHttpError(step, res.status, excerpt(res.text));
  }
  const body = parseJsonObject(res.text);
  if (!body) throw new CodexProtocolError(`Token ${step} response is not a JSON object.`);
  return tokensFromBody(body, opts, fallbackRefreshToken);
}

/** POST /oauth/token grant_type=authorization_code with the device redirect URI. */
export function exchangeDeviceGrant(grant: DeviceGrant, options?: CodexAuthOptions): Promise<CodexTokens> {
  const opts = resolve(options);
  return tokenRequest(opts, 'exchange', {
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    code: grant.authorizationCode,
    redirect_uri: CODEX_DEVICE_REDIRECT_URI,
    code_verifier: grant.codeVerifier,
  });
}

/**
 * POST /oauth/token grant_type=refresh_token. Keeps the old refresh token if the server omits one.
 *
 * OpenAI rotates refresh tokens. Do not call this with a token CLIProxyAPI also holds: whoever refreshes second gets
 * `refresh_token_reused` (CodexRefreshReusedError, never retried). After uploading to CPA, let CPA refresh.
 */
export async function refreshTokens(
  refreshToken: string,
  options: CodexAuthOptions & {
    /** Extra attempts after the first, default 0. CPA itself uses 3 attempts with 1 s, 2 s backoff. */
    retries?: number;
    /** Injectable sleep for tests; must reject on abort. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<CodexTokens> {
  if (typeof refreshToken !== 'string' || !refreshToken.trim()) throw new TypeError('refreshTokens needs a non-empty refresh token.');
  const opts = resolve(options);
  const retries = Math.max(0, Math.floor(options.retries ?? 0));
  const sleep = options.sleep ?? defaultSleep;
  const token = refreshToken.trim();
  for (let attempt = 0; ; attempt++) {
    try {
      return await tokenRequest(
        opts,
        'refresh',
        { client_id: opts.clientId, grant_type: 'refresh_token', refresh_token: token, scope: 'openid profile email' },
        token,
      );
    } catch (error) {
      const retryable = !(error instanceof CodexRefreshReusedError) && (error as { code?: string }).code !== 'aborted';
      if (!retryable || attempt >= retries) throw error;
      throwIfAborted(opts.signal);
      await sleep(1000 * (attempt + 1), opts.signal);
    }
  }
}
