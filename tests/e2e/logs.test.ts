// The parser follows CLIProxyAPI's logrus formatter; check it against the real binary.
import { describe, expect, it } from 'vitest';
import { startServer, type LogLine } from '../../src/server/index.ts';
import { findBinary } from './helpers.ts';

const binary = findBinary();

describe.skipIf(!binary)('structured logs with the real CPA', () => {
  it('parses startup lines and filters onLog by minLevel', async () => {
    const delivered: LogLine[] = [];
    const server = await startServer({
      binaryPath: binary!,
      localModel: true,
      logs: { minLevel: 'warn' },
      onLog: (log) => delivered.push(log),
    });
    try {
      const info = server.recentLogs.find((log) => log.level === 'info');
      expect(info).toMatchObject({ stream: 'stdout', level: 'info' });
      expect(info?.message).toBeTruthy();
      expect(info?.message).not.toContain('[info ]');
      expect(delivered.some((log) => log.level === 'info' || log.level === 'debug')).toBe(false);
      expect(server.recentLogs.some((log) => log.level === 'info')).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
