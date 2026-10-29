import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildArgs } from './args.ts';
import { resolveBinary, resolveLauncher } from './binary.ts';
import {
  inspectConfigFile,
  readManagedConfig,
  readManagedConfigObject,
  updateManagedSecret,
  writeManagedConfig,
  type PreparedConfig,
} from './config.ts';
import { CpaStartError } from './errors.ts';
import { keyMatches, resolveManagement, type ResolvedManagement } from './management.ts';
import { bundledPanel } from './panel.ts';
import { ManagedProcess } from './process.ts';
import { connectHost, findFreePort, formatOrigin, isLoopbackHost, isPortFree, probeHealth, type PortReservation } from './readiness.ts';
import { internalCommand, type InternalCommand } from './internal.ts';
import { createRedactor } from './redact.ts';
import { createWarner } from './warnings.ts';
import type {
  CpaServer,
  CpaServerEvents,
  ConfigContext,
  ExitReason,
  ExitResult,
  LogLine,
  RestartOptions,
  ServerClientOptions,
  StartServerOptions,
  StartWithConfigOptions,
  StopOptions,
} from './types.ts';
import { createClient } from '../client/index.ts';
import type { CpaConfig } from '../client/types/config.ts';

export { candidateTargets, currentPlatform, detectLibc, resolveBinary } from './binary.ts';
export type { HostPlatform, Libc, ResolvedBinary } from './binary.ts';
export { CpaBinaryError, CpaStartError } from './errors.ts';
export type { CpaBinaryErrorCode, CpaStartErrorCode } from './errors.ts';
export { TARGETS, NPM_SCOPE, UNSUPPORTED_PLATFORMS, binaryName, packageName } from './targets.ts';
export { CPA_PANEL, CPA_RELEASE } from './cpa-version.ts';
export type { Target, TargetBuild, TargetVerification } from './targets.ts';
export type * from './types.ts';
export type { CpaWarning, CpaWarningCode, SuppressWarnings } from './warnings.ts';
export type { CpaConfig } from '../client/types/config.ts';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const PROBE_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 1_000;
const DYNAMIC_PORT_ATTEMPTS = 3;

type ConfigFunction = (ctx: ConfigContext) => CpaConfig | Promise<CpaConfig>;

function validate(options: StartServerOptions): void {
  const config = typeof options.config === 'function' ? undefined : options.config;
  if (options.config !== undefined && options.configPath !== undefined) {
    throw new CpaStartError('invalid-options', 'config and configPath are mutually exclusive.');
  }
  if (typeof options.config === 'function' && options.overwriteConfig === true) {
    throw new CpaStartError(
      'invalid-options',
      'config as a function always replaces the managed config; remove overwriteConfig (or pass a config object).',
    );
  }
  if (options.configPath !== undefined && (options.host !== undefined || options.port !== undefined)) {
    throw new CpaStartError('invalid-options', 'host and port cannot be combined with configPath; set them in the file.');
  }
  if (options.home !== undefined && !options.home.jwt) {
    throw new CpaStartError('invalid-options', 'home.jwt must not be empty.');
  }
  const { port } = options;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
    throw new CpaStartError('invalid-options', `Invalid port ${String(port)}.`);
  }
  if (options.management !== undefined && options.managementKey !== undefined) {
    throw new CpaStartError(
      'invalid-options',
      'management and managementKey are mutually exclusive; managementKey is the deprecated alias for management.key.',
    );
  }
  if (options.management === false && options.managementKey !== undefined) {
    throw new CpaStartError('invalid-options', 'management: false disables the management API; do not also pass managementKey.');
  }
  if (
    options.management !== undefined &&
    options.management !== false &&
    (typeof options.management.key !== 'string' || options.management.key.trim() === '')
  ) {
    throw new CpaStartError('invalid-options', 'management.key must not be empty.');
  }
  if (typeof options.managementKey === 'string' && options.managementKey.trim() === '') {
    throw new CpaStartError('invalid-options', 'managementKey must not be empty.');
  }
  const viaEnvironment = options.management !== false && options.management?.viaEnvironment === true;
  if (!viaEnvironment && options.env?.MANAGEMENT_PASSWORD !== undefined) {
    throw new CpaStartError(
      'invalid-options',
      'Do not set MANAGEMENT_PASSWORD in env: cpajs only passes it to CPA for management: { key, viaEnvironment: true }, because upstream treats it as enabling remote management.',
    );
  }
  const requestedKey = (options.management === false ? undefined : options.management?.key) ?? options.managementKey;
  if (requestedKey === undefined) return;
  if (options.configPath !== undefined) {
    if (!viaEnvironment) {
      throw new CpaStartError(
        'invalid-options',
        'management.key cannot be combined with configPath because cpajs must not edit your config file. Put management.secret-key in the file, or use management.viaEnvironment: true to pass the key through MANAGEMENT_PASSWORD (which also enables remote management).',
      );
    }
    return;
  }
  const configuredSecret = config?.management?.['secret-key'];
  if (typeof configuredSecret === 'string' && configuredSecret.trim() !== '') {
    throw new CpaStartError(
      'invalid-options',
      'management.key conflicts with config.management["secret-key"]. Keep one key: either let cpajs hash management.key into the managed config, or set config.management["secret-key"] yourself.',
    );
  }
}

function buildEnv(options: StartServerOptions, management: ResolvedManagement): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  // MANAGEMENT_PASSWORD reaches CPA only through management.viaEnvironment. Upstream
  // accepts it as an extra plaintext key and forces remote management on, so one
  // inherited from the parent environment must never leak in.
  if (management.viaEnvironment) env.MANAGEMENT_PASSWORD = management.key;
  else delete env.MANAGEMENT_PASSWORD;
  if (options.home !== undefined) env.HOME_JWT = options.home.jwt;
  return env;
}

function configListen(options: StartWithConfigOptions, config: CpaConfig | undefined): { host: string; port: number } {
  const server = (config?.server ?? {}) as { host?: unknown; port?: unknown };
  const host = options.host ?? (typeof server.host === 'string' ? server.host : '127.0.0.1');
  const port = options.port ?? (typeof server.port === 'number' ? server.port : 0);
  return { host, port };
}

function abortError(signal: AbortSignal, output: string, message = 'startServer was aborted.'): CpaStartError {
  return new CpaStartError('aborted', message, { output, cause: signal.reason });
}

interface EventBus {
  emit<K extends keyof CpaServerEvents>(event: K, payload: CpaServerEvents[K]): void;
  on<K extends keyof CpaServerEvents>(event: K, listener: (event: CpaServerEvents[K]) => void): () => void;
}

function createEventBus(): EventBus {
  const listeners = new Map<keyof CpaServerEvents, Set<(event: unknown) => void>>();
  const emit = <K extends keyof CpaServerEvents>(event: K, payload: CpaServerEvents[K]): void => {
    const set = listeners.get(event);
    if (set === undefined) return;
    for (const listener of set) {
      try {
        (listener as (event: CpaServerEvents[K]) => void)(payload);
      } catch (error) {
        // A broken listener must not disturb the process lifecycle.
        process.emitWarning(`A CpaServer '${event}' listener threw: ${(error as Error)?.message ?? String(error)}`, {
          type: 'CpaWarning',
        });
      }
    }
  };
  const on = <K extends keyof CpaServerEvents>(event: K, listener: (event: CpaServerEvents[K]) => void): (() => void) => {
    const existing = listeners.get(event);
    const target = existing ?? new Set<(event: unknown) => void>();
    if (existing === undefined) listeners.set(event, target);
    const stored = listener as (event: unknown) => void;
    target.add(stored);
    return () => {
      target.delete(stored);
    };
  };
  return { emit, on };
}

/**
 * Copies the bundled panel into `stateDir` when the prepared config would serve
 * it, and points CPA at that copy. Removes a path cpajs set on an earlier start
 * once the config stops opting in, so CPA can fetch the panel it names instead.
 */
async function applyPinnedPanel(options: {
  panelFile: string | undefined;
  panelEligible: boolean;
  pinnedPanel: boolean;
  prepared: PreparedConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const staticPath = join(options.stateDir, 'static', 'management.html');
  if (options.pinnedPanel && options.panelFile !== undefined && options.prepared.management.servesPinnedPanel) {
    // A copy in stateDir, so a later opt-in to auto-update (through the management
    // API) makes CPA write there instead of into the installed package.
    await mkdir(join(options.stateDir, 'static'), { recursive: true });
    await copyFile(options.panelFile, staticPath);
    options.env.MANAGEMENT_STATIC_PATH = staticPath;
  } else if (options.panelEligible && options.env.MANAGEMENT_STATIC_PATH === staticPath) {
    // Only cpajs can have set this path; a caller-provided value makes panelEligible false.
    delete options.env.MANAGEMENT_STATIC_PATH;
  }
}

interface LaunchOptions {
  /** Executable to spawn: cpa-launcher, or CPA itself. */
  binaryPath: string;
  /** cpa-launcher supervise mode (process group + liveness pipe). */
  supervised: boolean;
  args: readonly string[];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  redact: (text: string) => string;
  onLog?: ((log: LogLine) => void) | undefined;
  host: string;
  port: number;
  origin: string;
  deadline: number;
  signal: AbortSignal | undefined;
  startupTimeoutMs: number;
  /** Description used when the port cannot be bound, e.g. `Port 8317 on 127.0.0.1 ...`. */
  portMessage: string;
  /** Retry with a different dynamically picked port on a bind race. */
  allowRetry: boolean;
  abortMessage: string;
}

type LaunchResult =
  | { kind: 'ready'; proc: ManagedProcess }
  | { kind: 'retry' }
  | { kind: 'failed'; error: CpaStartError; result: ExitResult | undefined };

/** Spawns CPA and waits for `/healthz`, stopping the child if it does not become ready. */
async function launchProcess(options: LaunchOptions): Promise<LaunchResult> {
  let proc: ManagedProcess;
  try {
    proc = new ManagedProcess(options.binaryPath, options.args, {
      supervised: options.supervised,
      cwd: options.stateDir,
      env: options.env,
      redact: options.redact,
      onLog: options.onLog,
    });
  } catch (cause) {
    // Node reports spawn failures through the 'error' event; Bun throws synchronously.
    const error = new CpaStartError('spawn-failed', `Failed to spawn ${options.binaryPath}: ${options.redact((cause as Error).message)}`, {
      cause,
    });
    return { kind: 'failed', error, result: undefined };
  }

  const outcome = await waitUntilReady(proc, options.origin, options.deadline, options.signal);
  if (outcome === 'ready') return { kind: 'ready', proc };

  // Not ready: make sure the process is gone before deciding what to report.
  const exit = await proc.stop(0);
  const output = proc.output();
  if (outcome === 'aborted') return { kind: 'failed', error: abortError(options.signal!, output, options.abortMessage), result: exit };
  if (outcome === 'timeout') {
    const error = new CpaStartError('timeout', `CLIProxyAPI did not become ready within ${options.startupTimeoutMs} ms.`, { output });
    return { kind: 'failed', error, result: exit };
  }
  if (proc.spawnError) {
    const error = new CpaStartError('spawn-failed', `Failed to spawn ${options.binaryPath}: ${options.redact(proc.spawnError.message)}`, {
      output,
      cause: proc.spawnError,
    });
    return { kind: 'failed', error, result: exit };
  }
  // CPA exits with code 0 when its bind fails, so the output cannot tell a
  // port conflict apart from any other early exit. Probe the port instead.
  // This is best-effort: the port can be taken or freed between the child's
  // bind attempt and this check.
  if (!(await isPortFree(options.host, options.port))) {
    // A dynamically picked port can be taken between probing and binding; try another.
    if (options.allowRetry) return { kind: 'retry' };
    const error = new CpaStartError('port-in-use', options.portMessage, {
      output,
      exitCode: exit.code,
      signal: exit.signal,
    });
    return { kind: 'failed', error, result: exit };
  }
  const error = new CpaStartError(
    'exited',
    `CLIProxyAPI exited before becoming ready (code ${String(exit.code)}, signal ${String(exit.signal)}).`,
    { output, exitCode: exit.code, signal: exit.signal },
  );
  return { kind: 'failed', error, result: exit };
}

/**
 * Starts the official CLIProxyAPI binary and resolves once `/healthz` answers.
 *
 * On any failure the child process is stopped and resources created by this
 * call (the temporary state directory) are removed before the error is thrown.
 */
export async function startServer(options: StartServerOptions = {}): Promise<CpaServer> {
  validate(options);
  const { signal } = options;
  if (signal?.aborted) throw abortError(signal, '');
  const events = createEventBus();

  const management = await resolveManagement({
    management: options.management,
    managementKey: options.managementKey,
    configPath: options.configPath,
    config: typeof options.config === 'function' ? undefined : options.config,
  });
  const command = (options as { [internalCommand]?: InternalCommand })[internalCommand];
  const binary =
    command === undefined
      ? resolveBinary(options.binaryPath === undefined ? {} : { binaryPath: options.binaryPath })
      : { path: command.path };
  // What actually gets spawned: CPA wrapped in cpa-launcher when available, so CPA
  // cannot outlive this process (see binary.ts and the launcher/ sources).
  const program = command?.path ?? binary.path;
  const launcher =
    options.launcher === false ? undefined : command !== undefined ? command.launcher : resolveLauncher(binary.path);
  const spawnPath = launcher?.path ?? program;
  const supervised = launcher?.mode === 'supervise';
  const prefixArgs = [
    ...(launcher === undefined ? [] : [...(supervised ? ['--supervise', '--watch-stdin'] : []), '--', program]),
    ...(command?.args ?? []),
  ];
  // Validate everything that can be validated before creating any resource, so a
  // rejected option never leaves a temporary state directory behind.
  const env = buildEnv(options, management);
  // Exec mode checks this after PR_SET_PDEATHSIG to catch a parent that died first.
  if (launcher?.mode === 'exec') env.CPAJS_PARENT_PID = String(process.pid);
  const extraArgs = buildArgs(options);
  // The pinned control panel (see panel.ts) is used only in a config cpajs manages,
  // when the caller has not chosen another panel source.
  const panelFile = command !== undefined ? command.panel : bundledPanel();
  const warn = createWarner(options);
  if (management.generated) {
    warn(
      'noManagementKey',
      'No management key given: generated one for this start (only its bcrypt hash is stored). Use server.client() for the management API, management: { key } to choose the key (which also enables the web control panel), or management: false to disable it.',
    );
  }
  const ownsStateDir = options.stateDir === undefined;
  const stateDir = ownsStateDir ? await mkdtemp(join(tmpdir(), 'cpajs-')) : resolve(options.stateDir!);
  if (!ownsStateDir) await mkdir(stateDir, { recursive: true });
  const cleanup = async (): Promise<void> => {
    // Windows releases file handles a little later than POSIX; keep retrying
    // instead of leaving a temporary directory behind.
    if (ownsStateDir) await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  // True when cpajs may serve its own panel for this stateDir; the config can
  // still opt out by naming a panel repository on each evaluation.
  const panelEligible =
    panelFile !== undefined &&
    options.management !== false &&
    options.configPath === undefined &&
    env.MANAGEMENT_STATIC_PATH === undefined;

  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const managedSecret =
    management.secretKeyHash === undefined
      ? undefined
      : {
          secretKeyHash: management.secretKeyHash,
          allowRemote: management.allowRemote,
          // Nobody knows a generated key, so the web panel could never log in; skip its download.
          ...(management.generated ? { disableControlPanel: true } : {}),
        };

  const configFn: ConfigFunction | undefined = typeof options.config === 'function' ? options.config : undefined;
  let reservation: PortReservation | undefined;
  let wroteConfig = false;
  try {
    // A config function is evaluated once before this start's first launch, and
    // again before every manual restart.
    const initialConfig: CpaConfig | undefined =
      configFn === undefined
        ? (options.config as CpaConfig | undefined)
        : await configFn({ existing: await readManagedConfigObject(stateDir), reason: 'start' });
    const pinnedPanel = panelEligible && initialConfig?.management?.['panel-github-repository'] === undefined;

    for (let attempt = 1; ; attempt++) {
      let prepared: PreparedConfig;
      let dynamicPort = false;
      if (options.configPath !== undefined) {
        prepared = await inspectConfigFile(options.configPath);
        if (management.key !== undefined && prepared.management.hasSecret) {
          throw new CpaStartError(
            'invalid-options',
            'management.key conflicts with the management.secret-key in configPath. Keep one key: remove management.key or remove secret-key from the file.',
          );
        }
      } else if (configFn !== undefined) {
        // The function ran once for this start; a dynamic-port retry only writes
        // the same result again with a fresh port.
        const listen = configListen(options, initialConfig);
        if (listen.port === 0) {
          reservation = await findFreePort(listen.host);
          listen.port = reservation.port;
          dynamicPort = true;
        }
        prepared = await writeManagedConfig(initialConfig ?? {}, stateDir, listen, managedSecret, { pinnedPanel });
        wroteConfig = true;
      } else {
        // The file belongs to CPA after the first start: management API writes and
        // CPA's own normalisation must survive later starts.
        const existing = options.overwriteConfig || wroteConfig ? undefined : await readManagedConfig(stateDir);
        if (existing) {
          prepared = existing;
          // A reused file keeps everything CPA persisted, but the key passed to this
          // start must still work: rewrite only the management fields when they differ.
          if (
            managedSecret !== undefined &&
            (existing.management.allowRemote !== managedSecret.allowRemote ||
              !(await keyMatches(management.key!, existing.management.secretKey)))
          ) {
            await updateManagedSecret(existing.configPath, managedSecret);
            prepared = (await readManagedConfig(stateDir))!;
            // A generated key changes on every start; only a caller's key change is news.
            if (!management.generated) {
              warn('managementKeyUpdated', `Replaced management.secret-key / allow-remote in ${existing.configPath} for the management key of this start.`);
            }
          }
          warn(
            'configReused',
            `Kept the existing config at ${existing.configPath}; this start's config, host and port were not applied. Pass overwriteConfig: true to replace it.`,
          );
        } else {
          const listen = configListen(options, initialConfig);
          if (listen.port === 0) {
            reservation = await findFreePort(listen.host);
            listen.port = reservation.port;
            dynamicPort = true;
          }
          prepared = await writeManagedConfig(initialConfig ?? {}, stateDir, listen, managedSecret, { pinnedPanel });
          wroteConfig = true;
        }
      }

      const { host, port, tls } = prepared.listen;
      const target = host === '' ? 'all interfaces' : host;
      const exposed = !isLoopbackHost(host);
      if (management.viaEnvironment) {
        warn(
          'managementViaEnvironment',
          'management.viaEnvironment passes the key through MANAGEMENT_PASSWORD, which upstream compares in plaintext and which always enables remote management' +
            (exposed ? `; the server binds ${target}, so the management API is reachable from non-loopback clients.` : '.'),
        );
      } else if (prepared.management.allowRemote && exposed) {
        warn(
          'remoteManagementExposed',
          `management.allow-remote is true and the server binds ${target}, so the management API is reachable from non-loopback clients.`,
        );
      }

      await applyPinnedPanel({ panelFile, panelEligible, pinnedPanel, prepared, stateDir, env });

      const redact = createRedactor([management.key, options.home?.jwt, ...prepared.secrets, ...(options.redact ?? [])]);
      if (!dynamicPort && !(await isPortFree(host, port))) {
        throw new CpaStartError('port-in-use', `Port ${port} on ${host || 'all interfaces'} is already in use.`);
      }

      const origin = formatOrigin(tls ? 'https' : 'http', connectHost(host), port);
      // Release the dynamic-port reservation as late as possible so the gap
      // before CPA binds stays small.
      const held = reservation;
      reservation = undefined;
      await held?.release();
      const result = await launchProcess({
        binaryPath: spawnPath,
        supervised,
        args: [...prefixArgs, '-config', prepared.configPath, ...extraArgs],
        stateDir,
        env,
        redact,
        onLog: options.onLog,
        host,
        port,
        origin,
        deadline: Date.now() + startupTimeoutMs,
        signal,
        startupTimeoutMs,
        portMessage: `Port ${port} on ${host || 'all interfaces'} is already in use.`,
        allowRetry: dynamicPort && attempt < DYNAMIC_PORT_ATTEMPTS,
        abortMessage: 'startServer was aborted.',
      });

      if (result.kind === 'ready') {
        const noClientReason =
          options.management === false
            ? 'the management API is disabled (management: false)'
            : options.configPath !== undefined
              ? 'with configPath, cpajs does not know the key; pass management: { key, viaEnvironment: true } or create a client with your own key'
              : "config.management['secret-key'] is set, so the key is yours; create a client with it";
        return createHandle(result.proc, {
          binaryPath: binary.path,
          managementKey: management.key,
          noClientReason,
          spawnPath,
          supervised,
          prefixArgs,
          configPath: prepared.configPath,
          listen: prepared.listen,
          origin,
          stateDir,
          env,
          extraArgs,
          redact,
          redactExtras: options.redact ?? [],
          homeJwt: options.home?.jwt,
          onLog: options.onLog,
          startupTimeoutMs,
          stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
          events,
          configFn,
          managedSecret,
          panelEligible,
          panelFile,
          cleanup,
        });
      }
      if (result.kind === 'retry') continue;
      throw result.error;
    }
  } catch (error) {
    await reservation?.release();
    await cleanup();
    throw error;
  }
}

async function waitUntilReady(
  proc: ManagedProcess,
  origin: string,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<'ready' | 'exited' | 'timeout' | 'aborted'> {
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  while (true) {
    if (signal?.aborted) return 'aborted';
    if (exited) return 'exited';
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    if (await probeHealth(origin, Math.min(PROBE_TIMEOUT_MS, remaining))) {
      // The probe may have raced the process exiting (e.g. another server on the port).
      return exited || proc.exitResult ? 'exited' : 'ready';
    }
    try {
      await delay(Math.min(PROBE_INTERVAL_MS, Math.max(0, deadline - Date.now())), undefined, signal ? { signal } : {});
    } catch {
      return 'aborted';
    }
  }
}

interface HandleInfo {
  /** The CPA binary (exposed on the handle). */
  binaryPath: string;
  /** Plaintext management key, kept private to back server.client(). */
  managementKey: string | undefined;
  /** Why server.client() is unavailable when there is no key. */
  noClientReason: string;
  /** What is spawned: cpa-launcher or CPA itself. */
  spawnPath: string;
  supervised: boolean;
  /** Arguments before `-config` (only set by the internal test launcher). */
  prefixArgs: readonly string[];
  configPath: string;
  listen: PreparedConfig['listen'];
  origin: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  extraArgs: readonly string[];
  redact: (text: string) => string;
  redactExtras: readonly string[];
  homeJwt: string | undefined;
  onLog?: ((log: LogLine) => void) | undefined;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
  /** Shared with the handle, so `on('exit')` works. */
  events: EventBus;
  /** Re-evaluated before each manual restart; `undefined` keeps the existing file. */
  configFn: ConfigFunction | undefined;
  managedSecret: { secretKeyHash: string; allowRemote: boolean; disableControlPanel?: boolean } | undefined;
  panelEligible: boolean;
  panelFile: string | undefined;
  cleanup: () => Promise<void>;
}

function createHandle(initialProc: ManagedProcess, info: HandleInfo): CpaServer {
  let currentProc = initialProc;
  let state: 'running' | 'restarting' | 'stopping' | 'stopped' = 'running';
  let restartTask: Promise<void> | undefined;
  let restartController: AbortController | undefined;
  let stopTask: Promise<ExitResult> | undefined;
  let resolveExited!: (result: ExitResult) => void;
  let finalizePromise: Promise<void> | undefined;
  const exited = new Promise<ExitResult>((resolve) => {
    resolveExited = resolve;
  });

  const emit = info.events.emit;

  const settle = (result: ExitResult): Promise<void> => {
    if (finalizePromise) return finalizePromise;
    state = 'stopped';
    liveServers.delete(handle);
    finalizePromise = (async () => {
      try {
        await info.cleanup();
      } finally {
        resolveExited(result);
      }
    })();
    return finalizePromise;
  };

  const notifyExit = (proc: ManagedProcess, result: ExitResult, willRestart: boolean, reason: ExitReason): void => {
    emit('exit', { code: result.code, signal: result.signal, recentLogs: [...proc.recentLogs], willRestart, reason });
  };

  const handleExit = (proc: ManagedProcess, result: ExitResult): void => {
    if (proc !== currentProc) return;
    if (state === 'stopped' || state === 'stopping') {
      // stop() settles the handle after the process is gone.
      notifyExit(proc, result, false, 'stop');
      return;
    }
    if (state === 'restarting') {
      notifyExit(proc, result, true, 'restart');
      return;
    }
    // state === 'running': the process died on its own.
    notifyExit(proc, result, false, 'unexpected');
    // An 'exit' listener may have stopped the server already.
    if (state !== 'running') return;
    void settle(result).catch(() => {});
  };

  const watch = (proc: ManagedProcess): void => {
    void proc.exited.then((result) => handleExit(proc, result));
  };

  const restart = (restartOptions: RestartOptions = {}): Promise<void> => {
    if (state === 'stopped' || state === 'stopping') {
      return Promise.reject(new CpaStartError('stopped', 'Cannot restart a stopped server.'));
    }
    if (restartTask) return restartTask;

    state = 'restarting';
    const controller = new AbortController();
    restartController = controller;
    const signal = restartOptions.signal
      ? AbortSignal.any([restartOptions.signal, controller.signal])
      : controller.signal;

    restartTask = (async () => {
      const previous = currentProc;
      const previousExit = await previous.stop(restartOptions.timeoutMs ?? info.stopTimeoutMs);
      if (signal.aborted) {
        await settle(previousExit);
        throw abortError(signal, previous.output(), 'restart was aborted.');
      }

      // Reuse the original port, dynamic or not. The old listener is gone, and
      // Go sets SO_REUSEADDR on Unix, so TIME_WAIT does not block the bind.
      // Windows relies on its default (Go does not set SO_REUSEADDR there);
      // either way another process holding the port is reported, never swapped.
      const { host, port } = info.listen;
      if (!(await isPortFree(host, port))) {
        await settle(previousExit);
        throw new CpaStartError('port-in-use', `Port ${port} on ${host || 'all interfaces'} is already in use.`);
      }

      try {
        if (info.configFn !== undefined) {
          const existing = await readManagedConfigObject(info.stateDir);
          const next = await info.configFn({ existing, reason: 'restart' });
          const pinnedPanel = info.panelEligible && next.management?.['panel-github-repository'] === undefined;
          const prepared = await writeManagedConfig(next, info.stateDir, { host, port }, info.managedSecret, {
            pinnedPanel,
          });
          await applyPinnedPanel({
            panelFile: info.panelFile,
            panelEligible: info.panelEligible,
            pinnedPanel,
            prepared,
            stateDir: info.stateDir,
            env: info.env,
          });
          info.redact = createRedactor([
            info.managementKey,
            info.homeJwt,
            ...prepared.secrets,
            ...info.redactExtras,
          ]);
        }
      } catch (error) {
        await settle(previousExit);
        throw error;
      }

      // Reuse the config file as CPA left it. Rewriting it here would discard
      // changes made through the management API during the previous run (#13).
      const result = await launchProcess({
        binaryPath: info.spawnPath,
        supervised: info.supervised,
        args: [...info.prefixArgs, '-config', info.configPath, ...info.extraArgs],
        stateDir: info.stateDir,
        env: info.env,
        redact: info.redact,
        onLog: info.onLog,
        host,
        port,
        origin: info.origin,
        deadline: Date.now() + info.startupTimeoutMs,
        signal,
        startupTimeoutMs: info.startupTimeoutMs,
        portMessage: `Port ${port} on ${host || 'all interfaces'} is already in use.`,
        allowRetry: false,
        abortMessage: 'restart was aborted.',
      });

      if (result.kind !== 'ready') {
        const failure = result as Extract<LaunchResult, { kind: 'failed' }>;
        await settle(failure.result ?? previousExit);
        throw failure.error;
      }

      currentProc = result.proc;
      watch(result.proc);
      state = 'running';
      // The process may have exited between the readiness probe and this point.
      if (result.proc.exitResult) void settle(result.proc.exitResult).catch(() => {});
    })().finally(() => {
      restartTask = undefined;
      restartController = undefined;
      if (state === 'restarting') state = 'running';
    });

    return restartTask;
  };

  const stop = (stopOptions: StopOptions = {}): Promise<ExitResult> => {
    stopTask ??= (async () => {
      if (state !== 'stopped') state = 'stopping';
      restartController?.abort(new Error('server stopped'));
      if (restartTask) {
        try {
          await restartTask;
        } catch {
          // An aborted restart always rejects; stop() still has to finish.
        }
      }
      await settle(await currentProc.stop(stopOptions.timeoutMs ?? info.stopTimeoutMs));
      return exited;
    })();
    return stopTask;
  };

  const handle: CpaServer = {
    origin: info.origin,
    baseUrl: `${info.origin}/v1`,
    host: info.listen.host,
    port: info.listen.port,
    binaryPath: info.binaryPath,
    configPath: info.configPath,
    stateDir: info.stateDir,
    get pid() {
      return currentProc.child.pid!;
    },
    get process() {
      return currentProc.child;
    },
    get recentLogs() {
      return [...currentProc.recentLogs];
    },
    exited,
    stop,
    restart,
    on: info.events.on,
    client(clientOptions: ServerClientOptions = {}) {
      if (info.managementKey === undefined) throw new Error(`server.client() is unavailable: ${info.noClientReason}.`);
      return createClient({ ...clientOptions, baseUrl: info.origin, managementKey: info.managementKey });
    },
  };
  watch(initialProc);
  liveServers.add(handle);
  return handle;
}

// Handles that have started and not settled yet, for stopAllServers().
const liveServers = new Set<CpaServer>();

/**
 * Stops every server started by this process and still running, using each
 * handle's `stop()` (so temporary state directories are removed too).
 *
 * The library does not install signal handlers. A host that should not leave
 * CPA processes behind on SIGTERM/SIGINT calls this from its own handler:
 *
 * ```ts
 * for (const signal of ['SIGINT', 'SIGTERM'] as const) {
 *   process.once(signal, async () => {
 *     await stopAllServers();
 *     process.exit(0);
 *   });
 * }
 * ```
 */
export async function stopAllServers(options: StopOptions = {}): Promise<ExitResult[]> {
  return Promise.all([...liveServers].map((server) => server.stop(options)));
}
