import {
  CodexAbortError,
  CodexAuthError,
  CodexDeviceTimeoutError,
  CodexDeviceUnavailableError,
  CodexHttpError,
  CodexNetworkError,
  CodexProtocolError,
  excerpt,
} from './errors.ts';
import {
  CODEX_DEFAULT_POLL_INTERVAL_SECONDS,
  CODEX_DEVICE_TIMEOUT_MS,
  CODEX_DEVICE_VERIFICATION_URL,
  type CodexAuthOptions,
  defaultSleep,
  JSON_HEADERS,
  parseJsonObject,
  resolve,
  send,
  str,
  throwIfAborted,
} from './http.ts';
import { type CodexTokens, exchangeDeviceGrant } from './tokens.ts';

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  /** Hard-coded by every implementation; the server does not return it. */
  verificationUrl: string;
  /** Seconds, already parsed (string or number from the server), at least 1, default 5. */
  intervalSeconds: number;
  /** now + 15 minutes, ISO string. Computed client-side. */
  expiresAt: string;
}

export interface DeviceGrant {
  authorizationCode: string;
  codeVerifier: string;
}

export type DevicePollResult =
  | {
      status: 'pending';
      /** Set when the server asked to slow down (RFC 8628). Defensive: OpenAI is not known to emit it. */
      slowDown?: true;
    }
  | { status: 'approved'; grant: DeviceGrant };

function parseInterval(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return CODEX_DEFAULT_POLL_INTERVAL_SECONDS;
  return Math.max(1, n);
}

/** POST /api/accounts/deviceauth/usercode */
export async function startDeviceAuth(options?: CodexAuthOptions): Promise<DeviceCode> {
  const opts = resolve(options);
  const res = await send(opts, `${opts.issuer}/api/accounts/deviceauth/usercode`, {
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ client_id: opts.clientId }),
  });
  if (res.status === 404) throw new CodexDeviceUnavailableError(res.status, excerpt(res.text));
  if (!res.ok) throw new CodexHttpError('usercode', res.status, excerpt(res.text));
  const body = parseJsonObject(res.text);
  if (!body) throw new CodexProtocolError('Device code response is not a JSON object.');
  const deviceAuthId = str(body.device_auth_id);
  const userCode = str(body.user_code) || str(body.usercode);
  if (!deviceAuthId || !userCode) throw new CodexProtocolError('Device code response is missing device_auth_id or user_code.');
  return {
    deviceAuthId,
    userCode,
    verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    intervalSeconds: parseInterval(body.interval),
    expiresAt: new Date(opts.now() + CODEX_DEVICE_TIMEOUT_MS).toISOString(),
  };
}

/** One POST to /deviceauth/token. Throws typed errors for anything but 2xx/403/404 (plus the defensive RFC 8628 errors). */
export async function pollDeviceAuth(
  code: Pick<DeviceCode, 'deviceAuthId' | 'userCode'>,
  options?: CodexAuthOptions,
): Promise<DevicePollResult> {
  const opts = resolve(options);
  const res = await send(opts, `${opts.issuer}/api/accounts/deviceauth/token`, {
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
  });
  if (res.ok) {
    const body = parseJsonObject(res.text);
    const authorizationCode = str(body?.authorization_code);
    const codeVerifier = str(body?.code_verifier);
    if (!body || !authorizationCode || !codeVerifier) {
      throw new CodexProtocolError('Device token response is missing authorization_code or code_verifier.');
    }
    // code_challenge is returned but the exchange never sends it.
    return { status: 'approved', grant: { authorizationCode, codeVerifier } };
  }
  if (res.status === 403 || res.status === 404) return { status: 'pending' };

  // Defensive RFC 8628 handling; nothing in the Codex clients or CPA shows OpenAI emitting these.
  const error = str(parseJsonObject(res.text)?.error);
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'pending', slowDown: true };
  if (error === 'expired_token') throw new CodexDeviceTimeoutError('The server reported the device code as expired.');
  if (error === 'access_denied') throw new CodexHttpError('devicetoken', res.status, excerpt(res.text), 'access_denied');
  throw new CodexHttpError('devicetoken', res.status, excerpt(res.text));
}

export interface WaitOptions extends CodexAuthOptions {
  /** Overrides the server interval (seconds). */
  intervalSeconds?: number;
  /** Absolute deadline; default code.expiresAt. */
  deadline?: Date | number;
  /** Injectable sleep for tests; must reject on abort. Default: setTimeout based. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onPoll?: (info: { attempt: number; nextDelayMs: number; error?: unknown }) => void;
  /** Consecutive network errors tolerated before failing; default Infinity (until the deadline). */
  maxNetworkErrors?: number;
}

/** RFC 8628 section 3.5: add 5 seconds to the interval on every slow_down. */
const SLOW_DOWN_STEP_SECONDS = 5;

/**
 * Polls until approved, then exchanges. The first poll is immediate. Network errors are retried until the deadline
 * (or `maxNetworkErrors`); any HTTP error other than 403/404 ends the login.
 * Rejects with CodexDeviceTimeoutError, CodexAbortError, CodexHttpError, CodexNetworkError, ...
 */
export async function completeDeviceAuth(code: DeviceCode, options: WaitOptions = {}): Promise<CodexTokens> {
  const opts = resolve(options);
  const sleep = options.sleep ?? defaultSleep;
  const deadline = options.deadline === undefined ? Date.parse(code.expiresAt) : +options.deadline;
  const maxNetworkErrors = options.maxNetworkErrors ?? Number.POSITIVE_INFINITY;
  let intervalSeconds = options.intervalSeconds === undefined ? code.intervalSeconds : Math.max(1, options.intervalSeconds);
  let attempt = 0;
  let networkErrors = 0;

  for (;;) {
    throwIfAborted(opts.signal);
    if (opts.now() >= deadline) throw new CodexDeviceTimeoutError();
    attempt++;

    let result: DevicePollResult | undefined;
    let failure: unknown;
    try {
      result = await pollDeviceAuth(code, options);
    } catch (error) {
      if (!(error instanceof CodexNetworkError)) throw error;
      if (++networkErrors > maxNetworkErrors) throw error;
      failure = error;
    }

    if (result?.status === 'approved') {
      options.onPoll?.({ attempt, nextDelayMs: 0 });
      return exchangeDeviceGrant(result.grant, options);
    }
    if (result) {
      networkErrors = 0;
      if (result.slowDown) intervalSeconds += SLOW_DOWN_STEP_SECONDS;
    }
    const nextDelayMs = intervalSeconds * 1000;
    options.onPoll?.({ attempt, nextDelayMs, ...(failure === undefined ? {} : { error: failure }) });
    try {
      await sleep(nextDelayMs, opts.signal);
    } catch (error) {
      if (opts.signal?.aborted && !(error instanceof CodexAuthError)) throw new CodexAbortError('The operation was aborted.', { cause: error });
      throw error;
    }
  }
}

/** start + show + complete in one call. `onCode` is where you display userCode and verificationUrl. */
export async function loginWithDeviceCode(options: WaitOptions & { onCode: (code: DeviceCode) => void | Promise<void> }): Promise<CodexTokens> {
  const { onCode, ...rest } = options;
  const code = await startDeviceAuth(rest);
  await onCode(code);
  return completeDeviceAuth(code, rest);
}
