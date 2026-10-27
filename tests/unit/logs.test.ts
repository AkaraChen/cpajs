import { describe, expect, it } from 'vitest';
import { parseLogLine, passesLogFilter } from '../../src/server/logs.ts';
import type { LogLevel } from '../../src/server/types.ts';

// Samples captured from CLIProxyAPI v8.0.43 (`internal/logging/global_logger.go`).
const TIMESTAMP = '2026-10-27 03:18:01';

describe('log line parsing', () => {
  it('parses CPA lines with a caller and a request id', () => {
    expect(
      parseLogLine(
        `[${TIMESTAMP}] [1b214a39] [info ] [gin_logger.go:113] 200 |            0s |       127.0.0.1 | GET     "/v1/models"`,
      ),
    ).toEqual({
      level: 'info',
      requestId: '1b214a39',
      message: '200 |            0s |       127.0.0.1 | GET     "/v1/models"',
    });
  });

  it('parses every level and omits the request id placeholder', () => {
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const) {
      expect(parseLogLine(`[${TIMESTAMP}] [--------] [${level}] [main.go:1] sample ${level}`)).toEqual({
        level,
        message: `sample ${level}`,
      });
    }
  });

  it('parses lines without caller information', () => {
    expect(parseLogLine(`[${TIMESTAMP}] [--------] [info ] created missing auth directory: auths`)).toEqual({
      level: 'info',
      message: 'created missing auth directory: auths',
    });
  });

  it('keeps fields it understands for levels outside the documented set', () => {
    expect(parseLogLine(`[${TIMESTAMP}] [7fda6985] [panic] [main.go:1] boom`)).toEqual({
      requestId: '7fda6985',
      message: 'boom',
    });
  });

  it('leaves lines without CPA prefixes unparsed', () => {
    for (const line of [
      'CLIProxyAPI Version: 8.0.43, Commit: 3078035, BuiltAt: 2026-10-25T14:45:00Z',
      'API server started successfully on: 127.0.0.1:18317',
      'time="2026-10-27T03:18:01Z" level=info msg="old format"',
      'server clients and configuration updated: 0 clients',
    ]) {
      expect(parseLogLine(line)).toEqual({});
    }
  });
});

describe('log level filtering', () => {
  const out = (level?: LogLevel) => ({ stream: 'stdout' as const, ...(level ? { level } : {}) });
  const err = (level?: LogLevel) => ({ stream: 'stderr' as const, ...(level ? { level } : {}) });

  it('drops lower levels and keeps equal or higher ones', () => {
    expect(passesLogFilter(out('debug'), { minLevel: 'warn' })).toBe(false);
    expect(passesLogFilter(out('info'), { minLevel: 'warn' })).toBe(false);
    expect(passesLogFilter(out('warn'), { minLevel: 'warn' })).toBe(true);
    expect(passesLogFilter(out('error'), { minLevel: 'warn' })).toBe(true);
    expect(passesLogFilter(out('fatal'), { minLevel: 'error' })).toBe(true);
  });

  it('lets unparsed lines and lines without a minimum through by default', () => {
    expect(passesLogFilter(out(), { minLevel: 'error' })).toBe(true);
    expect(passesLogFilter(out('debug'), {})).toBe(true);
    expect(passesLogFilter(out('debug'), undefined)).toBe(true);
  });

  it('filters unparsed lines by stream with unleveled', () => {
    expect(passesLogFilter(out(), { minLevel: 'warn', unleveled: 'stderr' })).toBe(false);
    expect(passesLogFilter(err(), { minLevel: 'warn', unleveled: 'stderr' })).toBe(true);
    expect(passesLogFilter(err(), { minLevel: 'warn', unleveled: 'none' })).toBe(false);
    expect(passesLogFilter(err('error'), { minLevel: 'warn', unleveled: 'none' })).toBe(true);
    // Without minLevel nothing is filtered, unleveled included.
    expect(passesLogFilter(out(), { unleveled: 'none' })).toBe(true);
  });
});
