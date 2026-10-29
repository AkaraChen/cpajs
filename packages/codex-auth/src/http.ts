import { CodexAbortError, CodexNetworkError } from './errors.ts';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_DEVICE_VERIFICATION_URL = 'https://auth.openai.com/codex/device';
export const CODEX_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
export const CODEX_DEVICE_TIMEOUT_MS = 15 * 60_000;
export const CODEX_DEFAULT_POLL_INTERVAL_SECONDS = 5;

/**
 * The subset of `fetch` this package calls. A plain function type rather than
 * `typeof fetch`, whose extra members (e.g. Bun's `preconnect`) a test double
 * would otherwise have to fake.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Injectable pieces shared by every network function. */
export interface CodexAuthOptions {
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Defaults to https://auth.openai.com. A trailing slash is trimmed. */
  issuer?: string;
  /** Defaults to the Codex CLI client id, the one CLIProxyAPI uses. */
  clientId?: string;
  /** Defaults to () => Date.now(). Used for expiresAt, expired and last_refresh. */
  now?: () => number;
  /** Per-request timeout, default 30_000. */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResolvedOptions {
  fetch: FetchLike;
  issuer: string;
  clientId: string;
  now: () => number;
  requestTimeoutMs: number;
  signal: AbortSignal | undefined;
}

export function resolve(options: CodexAuthOptions = {}): ResolvedOptions {
  return {
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    issuer: (options.issuer ?? CODEX_ISSUER).replace(/\/+$/, ''),
    clientId: options.clientId ?? CODEX_CLIENT_ID,
    now: options.now ?? Date.now,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    signal: options.signal,
  };
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CodexAbortError('The operation was aborted.', { cause: signal.reason });
}

export interface RawResponse {
  status: number;
  ok: boolean;
  text: string;
}

/** One request with the per-request timeout; fetch failures become CodexNetworkError / CodexAbortError. */
export async function send(opts: ResolvedOptions, url: string, init: { headers: Record<string, string>; body: string }): Promise<RawResponse> {
  throwIfAborted(opts.signal);
  const signals = [AbortSignal.timeout(opts.requestTimeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  try {
    const res = await opts.fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal: AbortSignal.any(signals) });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (error) {
    if (opts.signal?.aborted) throw new CodexAbortError('The operation was aborted.', { cause: error });
    throw new CodexNetworkError(`Request to ${new URL(url).pathname} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const;
export const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } as const;

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Default sleep: setTimeout that rejects with CodexAbortError when the signal fires. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new CodexAbortError('The operation was aborted.', { cause: signal.reason }));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CodexAbortError('The operation was aborted.', { cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
