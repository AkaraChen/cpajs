import type { ChildProcess } from 'node:child_process';
import type { CpaConfig } from '../client/types/config.ts';

export interface LogLine {
  stream: 'stdout' | 'stderr';
  /** One line of output with secrets redacted and the trailing newline removed. */
  line: string;
}

interface CommonServerOptions {
  /** Use this executable instead of the bundled platform package. */
  binaryPath?: string;
  /**
   * Working directory for CPA and home of the managed config file and auth
   * directory. When omitted, a temporary directory is created and removed on stop.
   */
  stateDir?: string;
  /**
   * Management key passed to CPA through the `MANAGEMENT_PASSWORD` environment
   * variable, so it never touches disk. Note that upstream treats this variable
   * as allowing remote management access regardless of `management.allow-remote`.
   */
  managementKey?: string;
  /** Extra CLI arguments, e.g. `['-local-model']`. Passed as an argv array, never through a shell. */
  args?: readonly string[];
  /** Environment for the child process. Defaults to `process.env`; entries set to `undefined` are removed. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Maximum time to wait for `/healthz` to answer. Default 30 000 ms. */
  startupTimeoutMs?: number;
  /** Cancels startup. After startup it has no effect; call `stop()` instead. */
  signal?: AbortSignal;
  /** Receives every output line, redacted. */
  onLog?: (log: LogLine) => void;
  /** Additional strings to redact from logs and errors. */
  redact?: readonly string[];
  /** Default grace period for `stop()` before the process is killed. Default 10 000 ms. */
  stopTimeoutMs?: number;
}

export interface StartWithConfigOptions extends CommonServerOptions {
  /**
   * Native CPA configuration. It is written to `<stateDir>/config.yaml` on
   * every start, replacing whatever CPA persisted there during the last run.
   */
  config?: CpaConfig;
  configPath?: never;
  /** Bind host. Overrides `config.server.host`. Default `127.0.0.1`. */
  host?: string;
  /** Bind port. Overrides `config.server.port`. Default `0`, meaning a free port is picked. */
  port?: number;
}

export interface StartWithConfigPathOptions extends CommonServerOptions {
  /** Existing CPA config file, handed to CPA as-is. CPA may rewrite it (e.g. to hash `secret-key`). */
  configPath: string;
  config?: never;
  host?: never;
  port?: never;
}

export type StartServerOptions = StartWithConfigOptions | StartWithConfigPathOptions;

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface StopOptions {
  /** Grace period after the termination signal before the process is killed. */
  timeoutMs?: number;
}

export interface CpaServer {
  /** e.g. `http://127.0.0.1:8317`. Use as the client `baseUrl`. */
  readonly origin: string;
  /** Model API base URL (`<origin>/v1`) for OpenAI-compatible SDKs. */
  readonly baseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  readonly binaryPath: string;
  readonly configPath: string;
  readonly stateDir: string;
  /** The management key given in the options, if any. */
  readonly managementKey: string | undefined;
  readonly process: ChildProcess;
  /** Recent output lines (redacted), oldest first. */
  readonly recentLogs: readonly LogLine[];
  /** Settles when the process exits, whether or not `stop()` was called. */
  readonly exited: Promise<ExitResult>;
  /** Terminates CPA gracefully, killing it after the grace period. Idempotent. */
  stop(options?: StopOptions): Promise<ExitResult>;
}
