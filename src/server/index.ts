import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildArgs } from './args.ts';
import { resolveBinary } from './binary.ts';
import { inspectConfigFile, readManagedConfig, updateManagedSecret, writeManagedConfig, type PreparedConfig } from './config.ts';
import { CpaStartError } from './errors.ts';
import { keyMatches, resolveManagement, type ResolvedManagement } from './management.ts';
import { ManagedProcess } from './process.ts';
import { connectHost, findFreePort, formatOrigin, isLoopbackHost, isPortFree, probeHealth, type PortReservation } from './readiness.ts';
import { createRedactor } from './redact.ts';
import type { CpaServer, ExitResult, StartServerOptions, StartWithConfigOptions } from './types.ts';

export { candidateTargets, currentPlatform, detectLibc, resolveBinary } from './binary.ts';
export type { HostPlatform, Libc, ResolvedBinary } from './binary.ts';
export { CpaBinaryError, CpaStartError } from './errors.ts';
export type { CpaBinaryErrorCode, CpaStartErrorCode } from './errors.ts';
export { TARGETS, NPM_SCOPE, UNSUPPORTED_PLATFORMS, binaryName, packageName } from './targets.ts';
export { CPA_RELEASE } from './cpa-version.ts';
export type { Target, TargetBuild, TargetVerification } from './targets.ts';
export type * from './types.ts';
export type { CpaConfig } from '../client/types/config.ts';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const PROBE_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 1_000;
const DYNAMIC_PORT_ATTEMPTS = 3;

function validate(options: StartServerOptions): void {
  if (options.config !== undefined && options.configPath !== undefined) {
    throw new CpaStartError('invalid-options', 'config and configPath are mutually exclusive.');
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
  if (
    options.management !== undefined &&
    (typeof options.management.key !== 'string' || options.management.key.trim() === '')
  ) {
    throw new CpaStartError('invalid-options', 'management.key must not be empty.');
  }
  if (typeof options.managementKey === 'string' && options.managementKey.trim() === '') {
    throw new CpaStartError('invalid-options', 'managementKey must not be empty.');
  }
  const requestedKey = options.management?.key ?? options.managementKey;
  if (requestedKey === undefined) return;
  if (options.configPath !== undefined) {
    if (options.management?.viaEnvironment !== true) {
      throw new CpaStartError(
        'invalid-options',
        'management.key cannot be combined with configPath because cpajs must not edit your config file. Put management.secret-key in the file, or use management.viaEnvironment: true to pass the key through MANAGEMENT_PASSWORD (which also enables remote management).',
      );
    }
    return;
  }
  const configuredSecret = options.config?.management?.['secret-key'];
  if (typeof configuredSecret === 'string' && configuredSecret.trim() !== '') {
    throw new CpaStartError(
      'invalid-options',
      'management.key conflicts with config.management["secret-key"]. Keep one key: either let cpajs hash management.key into the managed config, or set config.management["secret-key"] yourself.',
    );
  }
  if (options.management?.viaEnvironment !== true && options.env?.MANAGEMENT_PASSWORD !== undefined) {
    throw new CpaStartError(
      'invalid-options',
      'management.key writes a bcrypt hash into the config; do not also set MANAGEMENT_PASSWORD in env. Use management.viaEnvironment: true to pass the key through the environment.',
    );
  }
}

function buildEnv(options: StartServerOptions, management: ResolvedManagement): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  if (management.viaEnvironment) env.MANAGEMENT_PASSWORD = management.key;
  // The default mode must not accidentally inherit MANAGEMENT_PASSWORD: upstream
  // would enable remote access and stop verifying the hash in the config.
  else if (management.key !== undefined) delete env.MANAGEMENT_PASSWORD;
  if (options.home !== undefined) env.HOME_JWT = options.home.jwt;
  return env;
}

function configListen(options: StartWithConfigOptions): { host: string; port: number } {
  const server = (options.config?.server ?? {}) as { host?: unknown; port?: unknown };
  const host = options.host ?? (typeof server.host === 'string' ? server.host : '127.0.0.1');
  const port = options.port ?? (typeof server.port === 'number' ? server.port : 0);
  return { host, port };
}

function abortError(signal: AbortSignal, output: string): CpaStartError {
  return new CpaStartError('aborted', 'startServer was aborted.', { output, cause: signal.reason });
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

  const management = await resolveManagement(options);
  const binary = resolveBinary(options.binaryPath === undefined ? {} : { binaryPath: options.binaryPath });
  const ownsStateDir = options.stateDir === undefined;
  const stateDir = ownsStateDir ? await mkdtemp(join(tmpdir(), 'cpajs-')) : resolve(options.stateDir!);
  if (!ownsStateDir) await mkdir(stateDir, { recursive: true });
  const cleanup = async (): Promise<void> => {
    if (ownsStateDir) await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
  };

  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const deadline = Date.now() + startupTimeoutMs;
  const env = buildEnv(options, management);
  const extraArgs = buildArgs(options);
  const managedSecret =
    management.secretKeyHash === undefined
      ? undefined
      : { secretKeyHash: management.secretKeyHash, allowRemote: management.allowRemote };
  let warnedRemote = false;

  let reservation: PortReservation | undefined;
  let wroteConfig = false;
  let announcedReuse = false;
  try {
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
            options.onLog?.({
              stream: 'stdout',
              line: `Updated management.secret-key / allow-remote in ${existing.configPath} for the management key of this start.`,
            });
          }
          if (!announcedReuse) {
            announcedReuse = true;
            options.onLog?.({
              stream: 'stdout',
              line: `Keeping existing config at ${existing.configPath}; pass overwriteConfig: true to replace it.`,
            });
          }
        } else {
          const listen = configListen(options);
          if (listen.port === 0) {
            reservation = await findFreePort(listen.host);
            listen.port = reservation.port;
            dynamicPort = true;
          }
          prepared = await writeManagedConfig(options.config ?? {}, stateDir, listen, managedSecret);
          wroteConfig = true;
        }
      }

      const { host, port, tls } = prepared.listen;
      // Upstream trims MANAGEMENT_PASSWORD, and an empty value does not enable anything.
      const envSecret = env.MANAGEMENT_PASSWORD?.trim();
      const remoteManagement = Boolean(envSecret) || prepared.management.allowRemote;
      if (!warnedRemote && remoteManagement && !isLoopbackHost(host)) {
        warnedRemote = true;
        const reason = envSecret
          ? 'MANAGEMENT_PASSWORD makes upstream allow remote management'
          : 'management.allow-remote is true';
        const target = host === '' ? 'all interfaces' : host;
        options.onLog?.({
          stream: 'stderr',
          line: `cpajs: warning: ${reason} and the server binds ${target}, so the management API is reachable from non-loopback clients.`,
        });
      }

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
      let proc: ManagedProcess;
      try {
        proc = new ManagedProcess(binary.path, ['-config', prepared.configPath, ...extraArgs], {
          cwd: stateDir,
          env,
          redact,
          onLog: options.onLog,
        });
      } catch (cause) {
        // Node reports spawn failures through the 'error' event; Bun throws synchronously.
        throw new CpaStartError('spawn-failed', `Failed to spawn ${binary.path}: ${redact((cause as Error).message)}`, { cause });
      }

      const outcome = await waitUntilReady(proc, origin, deadline, signal);
      if (outcome === 'ready') {
        return createHandle(proc, {
          origin,
          host,
          port,
          binaryPath: binary.path,
          configPath: prepared.configPath,
          stateDir,
          managementKey: management.key,
          stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
          cleanup,
        });
      }

      // Not ready: make sure the process is gone before deciding what to report.
      const exit = await proc.stop(0);
      const output = proc.output();
      if (outcome === 'aborted') throw abortError(signal!, output);
      if (outcome === 'timeout') {
        throw new CpaStartError('timeout', `CLIProxyAPI did not become ready within ${startupTimeoutMs} ms.`, { output });
      }
      if (proc.spawnError) {
        throw new CpaStartError('spawn-failed', `Failed to spawn ${binary.path}: ${redact(proc.spawnError.message)}`, {
          output,
          cause: proc.spawnError,
        });
      }
      // CPA exits with code 0 when its bind fails, so the output cannot tell a
      // port conflict apart from any other early exit. Probe the port instead.
      // This is best-effort: the port can be taken or freed between the child's
      // bind attempt and this check.
      if (!(await isPortFree(host, port))) {
        // A dynamically picked port can be taken between probing and binding; try another.
        if (dynamicPort && attempt < DYNAMIC_PORT_ATTEMPTS) continue;
        throw new CpaStartError('port-in-use', `Port ${port} on ${host || 'all interfaces'} is already in use.`, {
          output,
          exitCode: exit.code,
          signal: exit.signal,
        });
      }
      throw new CpaStartError(
        'exited',
        `CLIProxyAPI exited before becoming ready (code ${String(exit.code)}, signal ${String(exit.signal)}).`,
        { output, exitCode: exit.code, signal: exit.signal },
      );
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

function createHandle(
  proc: ManagedProcess,
  info: {
    origin: string;
    host: string;
    port: number;
    binaryPath: string;
    configPath: string;
    stateDir: string;
    managementKey: string | undefined;
    stopTimeoutMs: number;
    cleanup: () => Promise<void>;
  },
): CpaServer {
  const exited: Promise<ExitResult> = proc.exited.then(async (result) => {
    await info.cleanup();
    return result;
  });
  return {
    origin: info.origin,
    baseUrl: `${info.origin}/v1`,
    host: info.host,
    port: info.port,
    pid: proc.child.pid!,
    binaryPath: info.binaryPath,
    configPath: info.configPath,
    stateDir: info.stateDir,
    managementKey: info.managementKey,
    process: proc.child,
    get recentLogs() {
      return [...proc.recentLogs];
    },
    exited,
    async stop(stopOptions = {}) {
      await proc.stop(stopOptions.timeoutMs ?? info.stopTimeoutMs);
      return exited;
    },
  };
}
