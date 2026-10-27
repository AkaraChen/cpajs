import type { LogLevel, LogLine } from './types.ts';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];

/**
 * CPA's logrus formatter prints
 * `[2026-10-27 03:18:01] [1b214a39] [info ] [gin_logger.go:113] message`.
 * The `[file:line]` part is omitted when logrus has no caller, and the request
 * ID is `--------` when the entry has none.
 */
const LOG_LINE_PATTERN =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([^\]]*)\] \[([a-z]+)\s*\](?: \[([^\]\s]+:\d+)\])? (.*)$/;

export function isLogLevel(value: string): value is LogLevel {
  return (LEVELS as readonly string[]).includes(value);
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
