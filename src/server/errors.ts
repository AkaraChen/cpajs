export type CpaBinaryErrorCode = 'unsupported-platform' | 'package-not-installed' | 'missing' | 'not-executable';

/** The CLIProxyAPI executable could not be located or used. */
export class CpaBinaryError extends Error {
  override readonly name = 'CpaBinaryError';
  readonly code: CpaBinaryErrorCode;

  constructor(code: CpaBinaryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type CpaStartErrorCode =
  /** Invalid `startServer` options. */
  | 'invalid-options'
  /** The configured port is already taken. */
  | 'port-in-use'
  /** The process exited before it became ready. */
  | 'exited'
  /** The process could not be spawned. */
  | 'spawn-failed'
  /** Readiness was not reached within `startupTimeoutMs`. */
  | 'timeout'
  /** The `signal` passed to `startServer` was aborted. */
  | 'aborted'
  /** An `afterStart` hook threw. */
  | 'hook-failed'
  /** `restart` was called after the server stopped. */
  | 'stopped';

/** `startServer` or `restart` failed. Secrets are redacted from `message` and `output`. */
export class CpaStartError extends Error {
  override readonly name = 'CpaStartError';
  readonly code: CpaStartErrorCode;
  /** Recent process output (redacted), useful for diagnosing failures. */
  readonly output: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    code: CpaStartErrorCode,
    message: string,
    details: { output?: string; exitCode?: number | null; signal?: NodeJS.Signals | null; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = code;
    this.output = details.output ?? '';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
  }
}
