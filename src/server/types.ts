import type { ChildProcess } from 'node:child_process';
import type { CpaConfig } from '../client/types/config.ts';

export interface LogLine {
  stream: 'stdout' | 'stderr';
  /** One line of output with secrets redacted and the trailing newline removed. */
  line: string;
}

export interface HomeOptions {
  /**
   * Home control plane JWT (`-home-jwt`). It is passed through the `HOME_JWT`
   * environment variable so it never appears in the process list, and it is
   * redacted from logs.
   */
  jwt: string;
  /** Keep using the JWT's address instead of discovering cluster nodes (`-home-disable-cluster-discovery`). */
  disableClusterDiscovery?: boolean;
}

export interface ManagementOptions {
  /** Management API key. Empty keys are rejected. */
  key: string;
  /**
   * Write `management.allow-remote`, which lets non-loopback clients use the
   * management API. Default `false`; ignored by `viaEnvironment`, which always
   * enables remote access upstream.
   */
  allowRemote?: boolean;
  /**
   * Pass the key to CPA through `MANAGEMENT_PASSWORD` instead of writing a
   * bcrypt hash into the managed config. Upstream treats that variable as
   * enabling remote management and compares the key in plaintext.
   */
  viaEnvironment?: boolean;
}

interface CommonServerOptions {
  /** Use this executable instead of the bundled platform package. */
  binaryPath?: string;
  /**
   * Working directory for CPA and home of the managed config file and auth
   * directory. When omitted, a temporary directory is created and removed on stop.
   */
  stateDir?: string;
  /** Management API key and how it reaches CPA. */
  management?: ManagementOptions;
  /**
   * Deprecated alias for `management: { key }`. It uses the safe default
   * (bcrypt hash in the config, remote management disabled) and will be removed
   * in a future release. Use `management.viaEnvironment` for the old
   * `MANAGEMENT_PASSWORD` behaviour.
   *
   * @deprecated Use `management` instead.
   */
  managementKey?: string;
  /**
   * Use the model catalogs embedded in the binary instead of fetching them
   * (`-local-model`). Explicit `models.*` config sources still win.
   */
  localModel?: boolean;
  /** Run as a node of a CPA Home control plane. Home mode disables the local management API. */
  home?: HomeOptions;
  /**
   * Extra CLI arguments, for flags that plugins register at runtime. Passed as
   * an argv array, never through a shell. One-shot commands (`-*-login`,
   * `-discover`, `-vertex-import`, `-siwc-bind`, `-tui`) and `-config` are rejected.
   */
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
   * Native CPA configuration.
   *
   * Written as YAML to `<stateDir>/config.yaml` only when that file does not
   * exist. On later starts the existing file is reused, so changes made through
   * the management API (or by CPA itself) survive a `stop()` / `startServer()`
   * cycle. Set `overwriteConfig: true` to replace it with this object.
   */
  config?: CpaConfig;
  configPath?: never;
  /**
   * Replace `<stateDir>/config.yaml` even when it already exists. Default
   * `false`. When the existing file is kept, `config`, `host` and `port` are not
   * applied and a message is emitted through `onLog`.
   */
  overwriteConfig?: boolean;
  /** Bind host, when cpajs writes the managed file. Default `config.server.host`, else `127.0.0.1`. */
  host?: string;
  /** Bind port, when cpajs writes the managed file. Default `config.server.port`, else `0` (a free port is picked). */
  port?: number;
}

export interface StartWithConfigPathOptions extends CommonServerOptions {
  /**
   * Existing CPA config file, handed to CPA as-is. CPA may rewrite it on
   * startup: it hashes a plaintext `management.secret-key`, removes legacy
   * keys that conflict with their v8 equivalents, and normalizes the layout.
   * The file must set a fixed positive port; a missing or non-positive port
   * makes CPA bind a random port it does not report.
   */
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
  /** The resolved management key (`management.key` or the deprecated alias), if any. */
  readonly managementKey: string | undefined;
  readonly process: ChildProcess;
  /** Recent output lines (redacted), oldest first. */
  readonly recentLogs: readonly LogLine[];
  /** Settles when the process exits, whether or not `stop()` was called. */
  readonly exited: Promise<ExitResult>;
  /** Terminates CPA gracefully, killing it after the grace period. Idempotent. */
  stop(options?: StopOptions): Promise<ExitResult>;
}
