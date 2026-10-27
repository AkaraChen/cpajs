import type { LogLevel, LogLine, LogOptions } from './types.ts';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

/**
 * CPA's logrus formatter prints
 * `[2026-10-27 03:18:01] [1b214a39] [info ] [gin_logger.go:113] message`.
 * The `[file:line]` part is omitted when logrus has no caller, and the request
 * ID is `--------` when the entry has none.
 */
const LOG_LINE_PATTERN =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([^\]]*)\] \[([a-z]+)\s*\](?: \[([^\]\s]+:\d+)\])? (.*)$/;

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVEL_RANK, value);
}

/** Extracts the structured fields CPA's formatter adds, if the line has them. */
export function parseLogLine(line: string): Pick<LogLine, 'level' | 'requestId' | 'message'> {
  const match = LOG_LINE_PATTERN.exec(line);
  if (!match) return {};
  const [, , rawRequestId, rawLevel, , message] = match;
  return {
    ...(rawLevel !== undefined && isLogLevel(rawLevel) ? { level: rawLevel } : {}),
    ...(rawRequestId !== undefined && rawRequestId !== '' && rawRequestId !== '--------' ? { requestId: rawRequestId } : {}),
    message: message ?? '',
  };
}

/**
 * True when `log` reaches `onLog`. Without `minLevel` everything passes; with it,
 * lines without a parsed level follow `unleveled` (default `'all'`), so unknown
 * output is not hidden unless asked.
 */
export function passesLogFilter(log: Pick<LogLine, 'level' | 'stream'>, options: LogOptions | undefined): boolean {
  const minLevel = options?.minLevel;
  if (minLevel === undefined) return true;
  if (log.level === undefined) {
    const unleveled = options?.unleveled ?? 'all';
    return unleveled === 'all' || (unleveled === 'stderr' && log.stream === 'stderr');
  }
  return LEVEL_RANK[log.level] >= LEVEL_RANK[minLevel];
}
