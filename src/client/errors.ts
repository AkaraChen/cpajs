/** Base class for every error thrown by the client. */
export class CpaClientError extends Error {
  override readonly name: string = 'CpaClientError';
  readonly method: string;
  readonly url: string;

  constructor(message: string, request: { method: string; url: string }, options?: { cause?: unknown }) {
    super(message, options);
    this.method = request.method;
    this.url = request.url;
  }
}

/**
 * The server answered with a non-2xx status.
 *
 * `body` is the raw response text. `data` is the parsed JSON body when there
 * was one; CPA errors usually look like `{ "error": "<code>", "message"?: "..." }`.
 */
export class CpaHttpError extends CpaClientError {
  override readonly name = 'CpaHttpError';
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: string;
  readonly data: unknown;

  constructor(
    request: { method: string; url: string },
    response: { status: number; statusText: string; headers: Headers },
    body: string,
  ) {
    const data = parseJsonOrUndefined(body);
    const detail = describeErrorBody(data) ?? (body.trim().slice(0, 200) || response.statusText);
    super(`${request.method} ${request.url} failed with ${response.status}${detail ? `: ${detail}` : ''}`, request);
    this.status = response.status;
    this.statusText = response.statusText;
    this.headers = response.headers;
    this.body = body;
    this.data = data;
  }

  /** The `error` field of a CPA error body, e.g. `"not_found"` or `"invalid management key"`. */
  get errorCode(): string | undefined {
    const value = (this.data as { error?: unknown } | undefined)?.error;
    return typeof value === 'string' ? value : undefined;
  }

  /** The `message` field of a CPA error body, when present. */
  get errorMessage(): string | undefined {
    const value = (this.data as { message?: unknown } | undefined)?.message;
    return typeof value === 'string' ? value : undefined;
  }
}

/** The request could not be sent or the response could not be read. */
export class CpaNetworkError extends CpaClientError {
  override readonly name = 'CpaNetworkError';
}

/** The request exceeded its timeout. */
export class CpaTimeoutError extends CpaClientError {
  override readonly name = 'CpaTimeoutError';
  readonly timeoutMs: number;

  constructor(request: { method: string; url: string }, timeoutMs: number, options?: { cause?: unknown }) {
    super(`${request.method} ${request.url} timed out after ${timeoutMs} ms`, request, options);
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's AbortSignal was aborted. `cause` is the signal's reason. */
export class CpaAbortError extends CpaClientError {
  override readonly name = 'CpaAbortError';
}

/** A 2xx response body did not match the expected format (e.g. invalid JSON). */
export class CpaResponseError extends CpaClientError {
  override readonly name = 'CpaResponseError';
  readonly status: number;
  readonly body: string;

  constructor(message: string, request: { method: string; url: string }, status: number, body: string, options?: { cause?: unknown }) {
    super(message, request, options);
    this.status = status;
    this.body = body;
  }
}

function parseJsonOrUndefined(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeErrorBody(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { error, message } = data as { error?: unknown; message?: unknown };
  const parts = [error, message].filter((v): v is string => typeof v === 'string' && v !== '');
  return parts.length ? parts.join(': ') : undefined;
}
