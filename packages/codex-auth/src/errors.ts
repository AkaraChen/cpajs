export type CodexHttpStep = 'usercode' | 'devicetoken' | 'exchange' | 'refresh';

/** Base class of every error this package throws. `code` is stable and safe to switch on. */
export class CodexAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
  }

  /** Keeps `JSON.stringify(error)` small and free of anything but the redacted message. */
  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message };
  }
}

/** A non-success HTTP answer. `bodyExcerpt` is at most 300 characters and has JWT-looking strings redacted. */
export class CodexHttpError extends CodexAuthError {
  readonly status: number;
  readonly bodyExcerpt: string;
  readonly step: CodexHttpStep;

  constructor(step: CodexHttpStep, status: number, bodyExcerpt: string, code = 'http_error') {
    super(code, `Codex ${step} request failed with HTTP ${status}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`);
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
    this.step = step;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), status: this.status, step: this.step, bodyExcerpt: this.bodyExcerpt };
  }
}

/** The usercode endpoint answered 404: device login is not available for this client or issuer. */
export class CodexDeviceUnavailableError extends CodexHttpError {
  constructor(status: number, bodyExcerpt: string) {
    super('usercode', status, bodyExcerpt, 'device_unavailable');
  }
}

/** The refresh token was already used (OpenAI rotates them). Never retried. */
export class CodexRefreshReusedError extends CodexHttpError {
  constructor(status: number, bodyExcerpt: string) {
    super('refresh', status, bodyExcerpt, 'refresh_token_reused');
  }
}

/** The 15 minute device-code deadline passed (or the server said `expired_token`). */
export class CodexDeviceTimeoutError extends CodexAuthError {
  constructor(message = 'The device code expired before it was approved.') {
    super('device_code_timeout', message);
  }
}

/** The caller's AbortSignal fired. */
export class CodexAbortError extends CodexAuthError {
  constructor(message = 'The operation was aborted.', options?: { cause?: unknown }) {
    super('aborted', message, options);
  }
}

/** fetch itself failed (DNS, connection, per-request timeout). */
export class CodexNetworkError extends CodexAuthError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('network_error', message, options);
  }
}

/** A 2xx body that is not what the endpoint is documented to return. */
export class CodexProtocolError extends CodexAuthError {
  constructor(message: string) {
    super('protocol_error', message);
  }
}

/** The id_token is not a decodable JWT. */
export class CodexIdTokenError extends CodexAuthError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('id_token_invalid', message, options);
  }
}

/** Tokens lack something CLIProxyAPI needs (email, access_token, refresh_token, id_token). */
export class CodexIncompleteTokensError extends CodexAuthError {
  constructor(message: string) {
    super('incomplete_tokens', message);
  }
}

const JWT_LIKE = /[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const TOKEN_FIELD = /("(?:access_token|refresh_token|id_token|code_verifier|authorization_code)"\s*:\s*")[^"]*(")/g;

/** Redacts JWT-looking strings and token fields, then truncates to `max` characters. */
export function excerpt(text: string, max = 300): string {
  const redacted = text.replace(TOKEN_FIELD, '$1[redacted]$2').replace(JWT_LIKE, '[redacted-jwt]').trim();
  return redacted.length > max ? redacted.slice(0, max) : redacted;
}
