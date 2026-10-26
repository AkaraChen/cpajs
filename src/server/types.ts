import type { ChildProcess } from 'node:child_process';
import type { CpaClient, ClientOptions } from '../client/index.ts';
import type { CpaConfig } from '../client/types/config.ts';
import type { CpaWarning, SuppressWarnings } from './warnings.ts';

export interface LogLine {
  stream: 'stdout' | 'stderr';
  /** One line of output with secrets redacted and the trailing newline removed. */
  line: string;
}

/** Options for `server.client()`: everything except the origin and the key. */
export type ServerClientOptions = Omit<ClientOptions, 'baseUrl' | 'managementKey'>;

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
  /**
   * Management API key and how it reaches CPA.
   *
   * Omitted: cpajs generates a random key for this start, writes only its bcrypt
   * hash into the managed config (remote management off) and keeps the plaintext
   * in memory; use `server.client()` to talk to the management API. Not done in
   * `configPath` mode or when `config.management['secret-key']` is set, because
   * then the secret is yours. `false`: the management API stays disabled.
   */
  management?: ManagementOptions | false;
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
  /**
   * Start CPA through `cpa-launcher` so it cannot outlive this process, even
   * when this process is killed with SIGKILL or crashes. Default `true`.
   *
   * - Linux: the launcher sets PR_SET_PDEATHSIG and execs CPA (no extra process).
   * - macOS / BSD: the launcher stays as CPA's parent and stops it when this
   *   process dies; `pid` is then the launcher's pid, and signals sent to it are
   *   forwarded to CPA.
   * - Windows: not needed; Node already kills child processes with their parent.
   *
   * The launcher ships next to the CPA binary in every platform package. With a
   * custom `binaryPath` it is looked up next to that binary and then in an
   * installed platform package; if none is found CPA is started directly and a
   * notice is logged through `onLog`.
   */
  launcher?: boolean;
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
  /**
   * Silences individual cpajs warnings, e.g. `{ noManagementKey: true }`. Every
   * warning message names the field that silences it.
   */
  suppressWarnings?: SuppressWarnings;
  /**
   * Receives cpajs warnings instead of `process.emitWarning` (which prints them
   * to stderr as `CpaWarning`). CPA's own output goes to `onLog`.
   */
  onWarning?: (warning: CpaWarning) => void;
  /** Receives every line CPA prints, redacted. */
  onLog?: (log: LogLine) => void;
  /** Additional strings to redact from logs and errors. */
  redact?: readonly string[];
  /** Default grace period for `stop()` before the process is killed. Ignored on Windows, where `stop()` terminates forcefully. Default 10 000 ms. */
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
  /** Grace period after the termination signal before the process is killed. Ignored on Windows, where the process is terminated forcefully right away. */
  timeoutMs?: number;
}

export interface RestartOptions {
  /**
   * Grace period after the termination signal before the old process is killed.
   * Defaults to `stopTimeoutMs`.
   */
  timeoutMs?: number;
  /** Cancels the restart. The server is left stopped, like any other failed restart. */
  signal?: AbortSignal;
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
  readonly process: ChildProcess;
  /** Recent output lines (redacted), oldest first. */
  readonly recentLogs: readonly LogLine[];
  /**
   * Settles when the process exits for good: on `stop()` or an unexpected exit.
   * A restart stops one process and starts another, so it does not settle this.
   */
  readonly exited: Promise<ExitResult>;
  /**
   * Stops CPA. On POSIX it sends SIGTERM and then SIGKILL after the grace
   * period. On Windows Node cannot deliver a graceful signal, so the process is
   * terminated forcefully (there is no grace period and CPA is not asked to
   * flush state or update auth files). Idempotent.
   */
  /**
   * A management API client already bound to this server's origin and key. The
   * key itself is not exposed. Works when cpajs knows the plaintext key (generated,
   * or passed as `management.key`); throws otherwise, e.g. with `configPath` or a
   * `secret-key` you put in `config` yourself.
   */
  client(options?: ServerClientOptions): CpaClient;
  stop(options?: StopOptions): Promise<ExitResult>;
  /**
   * Restarts CPA with the original options, reusing `origin`, `baseUrl`, `host`,
   * `port`, `stateDir` and the existing config file. Concurrent calls share one
   * operation. A failed or cancelled restart leaves the server stopped.
   */
  restart(options?: RestartOptions): Promise<void>;
}
