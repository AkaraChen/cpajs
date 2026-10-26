// cpajs warnings: coded, emitted once, routed to onWarning or process.emitWarning,
// and individually suppressible.
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type CpaServer, type CpaWarning, type StartServerOptions } from '../../src/server/index.ts';
import { internalCommand } from '../../src/server/internal.ts';
import { createWarner } from '../../src/server/warnings.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-cpa.mjs', import.meta.url));
const startFake = (options: StartServerOptions = {}): Promise<CpaServer> =>
  startServer({ ...options, [internalCommand]: { path: process.execPath, args: [FAKE] } } as unknown as StartServerOptions);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createWarner', () => {
  it('emits each code once, with the suppression hint, to onWarning', () => {
    const seen: CpaWarning[] = [];
    const warn = createWarner({ onWarning: (w) => seen.push(w) });
    warn('configReused', 'first');
    warn('configReused', 'second');
    warn('launcherMissing', 'other');
    expect(seen.map((w) => w.code)).toEqual(['configReused', 'launcherMissing']);
    expect(seen[0]!.message).toBe('first (suppress with suppressWarnings.configReused)');
  });

  it('uses process.emitWarning with type CpaWarning when there is no onWarning', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    createWarner({})('noManagementKey', 'hello');
    expect(emit).toHaveBeenCalledWith('hello (suppress with suppressWarnings.noManagementKey)', { type: 'CpaWarning', code: 'noManagementKey' });
  });

  it('suppresses only the listed codes', () => {
    const seen: string[] = [];
    const warn = createWarner({ suppressWarnings: { noManagementKey: true, configReused: false }, onWarning: (w) => seen.push(w.code) });
    warn('noManagementKey', 'x');
    warn('configReused', 'y');
    expect(seen).toEqual(['configReused']);
  });
});

describe('startServer warnings', () => {
  it('warns about a generated key by default, through process.emitWarning', async () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const server = await startFake();
    await server.stop();
    const codes = emit.mock.calls.map((call) => (call[1] as { code?: string } | undefined)?.code);
    expect(codes).toContain('noManagementKey');
  });

  it('routes warnings to onWarning instead, and can suppress noManagementKey', async () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const seen: CpaWarning[] = [];
    const server = await startFake({ onWarning: (w) => seen.push(w) });
    await server.stop();
    expect(seen.map((w) => w.code)).toContain('noManagementKey');
    expect(emit).not.toHaveBeenCalled();

    const quiet: CpaWarning[] = [];
    const silent = await startFake({ suppressWarnings: { noManagementKey: true }, onWarning: (w) => quiet.push(w) });
    await silent.stop();
    expect(quiet.map((w) => w.code)).not.toContain('noManagementKey');
  });

  it('does not warn about the key when one is given or management is off', async () => {
    for (const management of [{ key: 'explicit-key' }, false] as const) {
      const seen: CpaWarning[] = [];
      const server = await startFake({ management, onWarning: (w) => seen.push(w) });
      await server.stop();
      expect(seen.map((w) => w.code)).not.toContain('noManagementKey');
    }
  });

  it('keeps warnings out of onLog', async () => {
    const lines: string[] = [];
    const server = await startFake({ host: '0.0.0.0', management: { key: 'k', viaEnvironment: true }, onLog: (l) => lines.push(l.line), onWarning: () => {} });
    await server.stop();
    expect(lines.some((l) => l.includes('cpajs: warning') || l.includes('suppressWarnings'))).toBe(false);
  });
});
