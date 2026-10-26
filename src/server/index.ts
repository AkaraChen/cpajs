import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveBinary } from './binary.ts';
import { inspectConfigFile, writeManagedConfig, type PreparedConfig } from './config.ts';
import { CpaStartError } from './errors.ts';
import { ManagedProcess } from './process.ts';
import { connectHost, findFreePort, formatOrigin, isPortFree, probeHealth } from './readiness.ts';
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
const ADDRESS_IN_USE = /address already in use|only one usage of each socket address/i;

function validate(options: StartServerOptions): void {
  if (options.config !== undefined && options.configPath !== undefined) {
    throw new CpaStartError('invalid-options', 'config and configPath are mutually exclusive.');
  }
  if (options.configPath !== undefined && (options.host !== undefined || options.port !== undefined)) {
    throw new CpaStartError('invalid-options', 'host and port cannot be combined with configPath; set them in the file.');
  }
  const { port } = options;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
    throw new CpaStartError('invalid-options', `Invalid port ${String(port)}.`);
  }
}

function buildEnv(options: StartServerOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  if (options.managementKey !== undefined) env.MANAGEMENT_PASSWORD = options.managementKey;
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

  const binary = resolveBinary(options.binaryPath === undefined ? {} : { binaryPath: options.binaryPath });
  const ownsStateDir = options.stateDir === undefined;
  const stateDir = ownsStateDir ? await mkdtemp(join(tmpdir(), 'cpa-js-')) : resolve(options.stateDir!);
  if (!ownsStateDir) await mkdir(stateDir, { recursive: true });
  const cleanup = async (): Promise<void> => {
    if (ownsStateDir) await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
  };

  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const deadline = Date.now() + startupTimeoutMs;
  const env = buildEnv(options);

  try {
    for (let attempt = 1; ; attempt++) {
      let prepared: PreparedConfig;
      let dynamicPort = false;
      if (options.configPath !== undefined) {
        prepared = await inspectConfigFile(options.configPath);
      } else {
        const listen = configListen(options);
        if (listen.port === 0) {
          listen.port = await findFreePort(listen.host);
          dynamicPort = true;
        }
        prepared = await writeManagedConfig(options.config ?? {}, stateDir, listen);
      }

      const { host, port, tls } = prepared.listen;
      const redact = createRedactor([options.managementKey, ...prepared.secrets, ...(options.redact ?? [])]);
      if (!dynamicPort && !(await isPortFree(host, port))) {
        throw new CpaStartError('port-in-use', `Port ${port} on ${host || 'all interfaces'} is already in use.`);
      }

      const origin = formatOrigin(tls ? 'https' : 'http', connectHost(host), port);
      let proc: ManagedProcess;
      try {
        proc = new ManagedProcess(binary.path, ['-config', prepared.configPath, ...(options.args ?? [])], {
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
          managementKey: options.managementKey,
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
      if (ADDRESS_IN_USE.test(output)) {
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
