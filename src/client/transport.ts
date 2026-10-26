import { CpaAbortError, CpaHttpError, CpaNetworkError, CpaResponseError, CpaTimeoutError } from './errors.ts';

export const MANAGEMENT_PREFIX = '/v8/management';

export type FetchLike = (input: Request) => Promise<Response>;

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];
export type Query = Readonly<Record<string, QueryValue>>;

export interface ClientOptions {
  /**
   * Server root, e.g. `http://127.0.0.1:8317` or `https://example.com/cpa`.
   * A path prefix (reverse proxy) is kept; `/v8/management` is appended to it.
   */
  baseUrl: string | URL;
  /** Management key (`management.secret-key` or `MANAGEMENT_PASSWORD`), not a model API key. */
  managementKey: string;
  /** Custom fetch. Defaults to the global `fetch`. */
  fetch?: (input: Request) => Promise<Response>;
  /** Headers sent with every request. */
  headers?: HeadersInit;
  /** Default per-request timeout in ms. `0` or omitted disables it. */
  timeoutMs?: number;
}

/** Per-call options accepted by every client method. */
export interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** Overrides the client's default timeout; `0` disables it. */
  timeoutMs?: number | undefined;
  headers?: HeadersInit | undefined;
}

export type ResponseType = 'json' | 'text' | 'blob' | 'response';

export interface RawRequest extends RequestOptions {
  method: string;
  /** Path below `/v8/management` (e.g. `/config`), already encoded. */
  path: string;
  query?: Query;
  /** Serialised with `JSON.stringify`, including strings and `null`. */
  json?: unknown;
  /** Sent as-is. Mutually exclusive with `json`. */
  body?: BodyInit;
  /** Content type for `body`. FormData sets its own. */
  contentType?: string;
  responseType?: ResponseType;
  /** Skip the management key, for unauthenticated routes. */
  anonymous?: boolean;
  /** Resolve `path` against the server root instead of `/v8/management`. */
  root?: boolean;
}

export interface TransportResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

function appendQuery(url: URL, query: Query | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.append(key, String(value));
  }
}

/** Joins the base URL and a management path while keeping any base path prefix. */
export function managementUrl(baseUrl: string | URL, path: string, root = false): URL {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const url = new URL(base.origin);
  url.pathname = `${prefix}${root ? '' : MANAGEMENT_PREFIX}${path}`;
  return url;
}

export class Transport {
  readonly #baseUrl: URL;
  readonly #managementKey: string;
  readonly #fetch: FetchLike;
  readonly #headers: Headers;
  readonly #timeoutMs: number;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new TypeError('baseUrl is required.');
    if (!options.managementKey) throw new TypeError('managementKey is required.');
    this.#baseUrl = new URL(options.baseUrl);
    if (this.#baseUrl.protocol !== 'http:' && this.#baseUrl.protocol !== 'https:') {
      throw new TypeError(`baseUrl must be http(s), got ${this.#baseUrl.protocol}`);
    }
    this.#managementKey = options.managementKey;
    const custom = options.fetch;
    this.#fetch = custom ? (request) => custom(request) : (request) => fetch(request);
    this.#headers = new Headers(options.headers);
    this.#timeoutMs = options.timeoutMs ?? 0;
  }

  get baseUrl(): URL {
    return new URL(this.#baseUrl);
  }

  async request<T>(req: RawRequest): Promise<TransportResponse<T>> {
    const url = managementUrl(this.#baseUrl, req.path, req.root);
    appendQuery(url, req.query);
    const target = { method: req.method, url: url.toString() };

    const headers = new Headers(this.#headers);
    new Headers(req.headers).forEach((value, key) => headers.set(key, value));
    if (!req.anonymous) headers.set('Authorization', `Bearer ${this.#managementKey}`);

    let body: BodyInit | undefined;
    if ('json' in req) {
      body = JSON.stringify(req.json);
      headers.set('Content-Type', 'application/json');
    } else if (req.body !== undefined) {
      body = req.body;
      if (req.contentType) headers.set('Content-Type', req.contentType);
    }
    if (!headers.has('Accept')) headers.set('Accept', req.responseType === 'json' || !req.responseType ? 'application/json' : '*/*');

    const timeoutMs = req.timeoutMs ?? this.#timeoutMs;
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const signals = [req.signal, timeoutSignal].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    const classify = (error: unknown): Error => {
      if (req.signal?.aborted) return new CpaAbortError(`${target.method} ${target.url} was aborted`, target, { cause: req.signal.reason });
      if (timeoutSignal?.aborted) return new CpaTimeoutError(target, timeoutMs, { cause: error });
      return new CpaNetworkError(`${target.method} ${target.url} failed: ${(error as Error)?.message ?? String(error)}`, target, {
        cause: error,
      });
    };

    if (req.signal?.aborted) throw classify(req.signal.reason);

    const init: RequestInit = { method: req.method, headers, redirect: 'manual' };
    if (body !== undefined) init.body = body;
    if (signal) init.signal = signal;

    let response: Response;
    try {
      response = await this.#fetch(new Request(url, init));
    } catch (error) {
      throw classify(error);
    }

    const responseType = req.responseType ?? 'json';
    try {
      if (!response.ok) {
        throw new CpaHttpError(target, response, await response.text());
      }
      if (responseType === 'response') {
        return { data: response as T, status: response.status, headers: response.headers };
      }
      if (responseType === 'blob') {
        return { data: (await response.blob()) as T, status: response.status, headers: response.headers };
      }
      const text = await response.text();
      if (responseType === 'text') return { data: text as T, status: response.status, headers: response.headers };
      if (text === '') return { data: undefined as T, status: response.status, headers: response.headers };
      try {
        return { data: JSON.parse(text) as T, status: response.status, headers: response.headers };
      } catch (cause) {
        throw new CpaResponseError(`${target.method} ${target.url} returned invalid JSON`, target, response.status, text, { cause });
      }
    } catch (error) {
      if (error instanceof CpaHttpError || error instanceof CpaResponseError) throw error;
      throw classify(error);
    }
  }
}

/** Encodes `a/b/c` or `['a', 'b', 'c']` as URL path segments. */
export function encodePath(path: string | readonly string[], what = 'path'): string {
  const segments = typeof path === 'string' ? path.split('/').filter((s, i, all) => s !== '' || (i > 0 && i < all.length - 1)) : [...path];
  for (const segment of segments) {
    if (segment === '') throw new TypeError(`${what} contains an empty segment.`);
    if (typeof path !== 'string' && segment.includes('/')) {
      throw new TypeError(`${what} segment "${segment}" contains "/", which CPA cannot address; edit its parent instead.`);
    }
  }
  return segments.map(encodeURIComponent).join('/');
}
