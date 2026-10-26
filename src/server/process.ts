import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ExitResult, LogLine } from './types.ts';

const MAX_RECENT_LINES = 200;
/** Longest line kept, in UTF-16 code units; longer output is truncated with a marker. */
export const MAX_LINE_LENGTH = 64 * 1024;

// Children still running when this process exits normally (or calls
// process.exit()) are killed. This does not cover a fatal signal with no
// listener, e.g. a default SIGTERM: Node then terminates without emitting
// 'exit'. Hosts that want cleanup on signals call stopAllServers() from their
// own handlers; this library does not install signal handlers, because doing
// so would change how the host process reacts to them.
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function trackChild(child: ChildProcess): void {
  live.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const c of live) c.kill('SIGKILL');
  });
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  redact: (text: string) => string;
  onLog?: ((log: LogLine) => void) | undefined;
}

/** A spawned CPA process with line-buffered, redacted output and idempotent stop. */
export class ManagedProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<ExitResult>;
  readonly recentLogs: LogLine[] = [];
  /** Set when the process could not be spawned at all. */
  spawnError: Error | undefined;
  exitResult: ExitResult | undefined;

  readonly #redact: (text: string) => string;
  readonly #onLog: ((log: LogLine) => void) | undefined;
  readonly #lineListeners = new Set<(log: LogLine) => void>();
  #stopping: Promise<ExitResult> | undefined;

  constructor(binaryPath: string, args: readonly string[], options: SpawnOptions) {
    this.#redact = options.redact;
    this.#onLog = options.onLog;
    this.child = spawn(binaryPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    trackChild(this.child);

    this.exited = new Promise<ExitResult>((resolve) => {
      this.child.once('error', (error) => {
        this.spawnError = error;
        // 'exit' is not emitted when spawning fails.
        if (this.child.pid === undefined) this.#finish(resolve, { code: null, signal: null });
      });
      this.child.once('close', (code, signal) => this.#finish(resolve, { code, signal }));
    });

    this.#pipe(this.child.stdout, 'stdout');
    this.#pipe(this.child.stderr, 'stderr');
  }

  #finish(resolve: (result: ExitResult) => void, result: ExitResult): void {
    if (this.exitResult) return;
    this.exitResult = result;
    live.delete(this.child);
    resolve(result);
  }

  #pipe(stream: Readable | null, name: LogLine['stream']): void {
    if (!stream) return;
    stream.setEncoding('utf8');
    let pending = '';
    // Characters dropped from the line currently being received; bounds memory
    // when the child writes very long or never-terminated lines.
    let dropped = 0;
    const emit = (raw: string): void => {
      const text = raw.replace(/\r$/, '');
      const line = dropped > 0 ? `${text} …[truncated ${dropped} chars]` : text;
      dropped = 0;
      const log: LogLine = { stream: name, line: this.#redact(line) };
      this.recentLogs.push(log);
      if (this.recentLogs.length > MAX_RECENT_LINES) this.recentLogs.shift();
      for (const listener of this.#lineListeners) listener(log);
      this.#onLog?.(log);
    };
    stream.on('data', (chunk: string) => {
      pending += chunk;
      let index: number;
      while ((index = pending.indexOf('\n')) !== -1) {
        if (index > MAX_LINE_LENGTH) dropped += index - MAX_LINE_LENGTH;
        emit(pending.slice(0, Math.min(index, MAX_LINE_LENGTH)));
        pending = pending.slice(index + 1);
      }
      if (pending.length > MAX_LINE_LENGTH) {
        dropped += pending.length - MAX_LINE_LENGTH;
        pending = pending.slice(0, MAX_LINE_LENGTH);
      }
    });
    stream.on('end', () => {
      if (pending) emit(pending);
      pending = '';
    });
  }

  onLine(listener: (log: LogLine) => void): () => void {
    this.#lineListeners.add(listener);
    return () => this.#lineListeners.delete(listener);
  }

  output(): string {
    return this.recentLogs.map((l) => l.line).join('\n');
  }

  /**
   * Sends SIGTERM and waits up to `timeoutMs` before SIGKILL. On Windows Node
   * cannot deliver SIGTERM: both steps terminate the process forcefully, so
   * there is no grace period and the timeout is irrelevant.
   */
  stop(timeoutMs: number): Promise<ExitResult> {
    if (this.exitResult) return Promise.resolve(this.exitResult);
    this.#stopping ??= (async () => {
      this.child.kill('SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const first = await Promise.race([this.exited, timedOut]);
      clearTimeout(timer);
      if (first === 'timeout') this.child.kill('SIGKILL');
      return this.exited;
    })();
    return this.#stopping;
  }
}
