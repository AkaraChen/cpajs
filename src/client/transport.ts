import { CpaAbortError, CpaHttpError, CpaNetworkError, CpaResponseError, CpaTimeoutError } from './errors.ts';

export const MANAGEMENT_PREFIX = '/v8/management';

export type FetchLike = (input: Request) => Promise<Response>;

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];
export type Query = Readonly<Record<string, QueryValue>>;

/** A server root, or a function that returns the current one (used by `server.client()` across restarts). */
export type BaseUrl = string | URL | (() => string | URL);

export interface ClientOptions {
  /**
   * Server root, e.g. `http://127.0.0.1:8317` or `https://example.com/cpa`.
   * A path prefix (reverse proxy) is kept; `/v8/management` is appended to it.
   * A function is called for each request, so a client can follow a server that
   * changes its dynamic port.
   */
  baseUrl: BaseUrl;
  /** Management key (`management.secret-key` or `MANAGEMENT_PASSWORD`), not a model API key. */
  managementKey: string;
  /** Custom fetch. Defaults to the global `fetch`. */
  fetch?: (input: Request) => Promise<Response>;
  /** Headers sent with every request. */
  headers?: HeadersInit;
  /** Default per-request timeout in ms. `0` or omitted disables it. */
  timeoutMs?: number;
  /**
   * Retry GET requests that fail with CPA's transient `500 invalid_config`
   * (a config read landed while `config.yaml` was being rewritten). Defaults to
   * `true`: up to three retries after 100, 200 and 400 ms. Writes never retry.
   */
  retryInvalidConfig?: boolean;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveBaseUrl(baseUrl: BaseUrl): URL {
  const url = new URL(typeof baseUrl === 'function' ? baseUrl() : baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`baseUrl must be http(s), got ${url.protocol}`);
  }
  return url;
}

export class Transport {
  readonly #baseUrl: BaseUrl;
  readonly #managementKey: string;
  readonly #fetch: FetchLike;
  readonly #headers: Headers;
  readonly #timeoutMs: number;
  readonly #retryInvalidConfig: boolean;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new TypeError('baseUrl is required.');
    if (!options.managementKey) throw new TypeError('managementKey is required.');
    resolveBaseUrl(options.baseUrl);
    this.#baseUrl = options.baseUrl;
    this.#managementKey = options.managementKey;
    const custom = options.fetch;
    this.#fetch = custom ? (request) => custom(request) : (request) => fetch(request);
    this.#headers = new Headers(options.headers);
    this.#timeoutMs = options.timeoutMs ?? 0;
    this.#retryInvalidConfig = options.retryInvalidConfig ?? true;
  }

  get baseUrl(): URL {
    return resolveBaseUrl(this.#baseUrl);
  }

  async request<T>(req: RawRequest): Promise<TransportResponse<T>> {
    const url = managementUrl(resolveBaseUrl(this.#baseUrl), req.path, req.root);
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
    const userSignal = req.signal;
    let timedOut = false;
    const classify = (error: unknown): Error => {
      if (userSignal?.aborted) return new CpaAbortError(`${target.method} ${target.url} was aborted`, target, { cause: userSignal.reason });
      if (timedOut) return new CpaTimeoutError(target, timeoutMs, { cause: error });
      return new CpaNetworkError(`${target.method} ${target.url} failed: ${(error as Error)?.message ?? String(error)}`, target, {
        cause: error,
      });
    };
    if (userSignal?.aborted) throw classify(userSignal.reason);

    // One controller owned by this call, rather than AbortSignal.any/timeout: on some Node
    // versions signals derived that way can be garbage-collected before they fire.
    const controller = new AbortController();
    let rejectAborted: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    aborted.catch(() => {});
    const abort = (reason: unknown): void => {
      controller.abort(reason);
      rejectAborted(classify(reason));
    };
    const onUserAbort = (): void => abort(userSignal!.reason);
    userSignal?.addEventListener('abort', onUserAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        abort(new DOMException(`Timed out after ${timeoutMs} ms`, 'TimeoutError'));
      }, timeoutMs);
    }
    const release = (): void => {
      clearTimeout(timer);
      userSignal?.removeEventListener('abort', onUserAbort);
    };
    // Every await below races the abort, so a fetch that ignores its signal still settles.
    const guard = <V>(promise: Promise<V>): Promise<V> => Promise.race([promise, aborted]);

    const init: RequestInit = { method: req.method, headers, redirect: 'manual', signal: controller.signal };
    if (body !== undefined) init.body = body;

    const responseType = req.responseType ?? 'json';
    // A config read can land while CPA rewrites config.yaml non-atomically. Retry
    // only that transient 500, and only for GET: writes are not idempotent here.
    const retries = this.#retryInvalidConfig && req.method === 'GET' ? 3 : 0;
    // Set once a Response is handed to the caller, who then owns reading its body.
    let handedOff = false;
    try {
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await guard(this.#fetch(new Request(url, init)));
        } catch (error) {
          throw error instanceof CpaAbortError || error instanceof CpaTimeoutError ? error : classify(error);
        }
        if (response.ok) break;
        const httpError = new CpaHttpError(target, response, await guard(response.text()));
        const transient = httpError.status === 500 && httpError.errorCode === 'invalid_config';
        if (!transient || attempt >= retries) throw httpError;
        await guard(delay(100 * 2 ** attempt));
      }

      if (responseType === 'response') {
        handedOff = true;
        return { data: response as T, status: response.status, headers: response.headers };
      }
      if (responseType === 'blob') {
        return { data: (await guard(response.blob())) as T, status: response.status, headers: response.headers };
      }
      const text = await guard(response.text());
      if (responseType === 'text') return { data: text as T, status: response.status, headers: response.headers };
      if (text === '') return { data: undefined as T, status: response.status, headers: response.headers };
      try {
        return { data: JSON.parse(text) as T, status: response.status, headers: response.headers };
      } catch (cause) {
        throw new CpaResponseError(`${target.method} ${target.url} returned invalid JSON`, target, response.status, text, { cause });
      }
    } catch (error) {
      if (error instanceof CpaHttpError || error instanceof CpaResponseError || error instanceof CpaAbortError || error instanceof CpaTimeoutError) {
        throw error;
      }
      throw classify(error);
    } finally {
      // A handed-off Response is read by the caller: the timeout covered the headers
      // only, and the caller's signal must keep cancelling the body, so its listener
      // stays until that signal aborts. Every other outcome releases everything.
      if (handedOff) clearTimeout(timer);
      else release();
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
