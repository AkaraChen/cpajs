// The pinned control panel: copied into stateDir and served through
// MANAGEMENT_STATIC_PATH, with CPA's own panel download turned off.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { CpaConfig } from '../../src/client/index.ts';
import { startServer, type LogLine, type StartServerOptions } from '../../src/server/index.ts';
import { internalCommand } from '../../src/server/internal.ts';
import { findFreePort } from '../../src/server/readiness.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-cpa.mjs', import.meta.url));

let dir: string;
let panel: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cpajs-panel-'));
  panel = join(dir, 'pinned.html');
  await writeFile(panel, '<!doctype html><title>pinned panel</title>');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Start {
  config?: CpaConfig;
  management?: { key: string } | false;
  configPath?: string;
  env?: Record<string, string>;
  panel?: string | undefined;
}

/** Starts the fake and reports the panel path CPA was given and the written management section. */
async function start(options: Start) {
  const lines: string[] = [];
  const { panel: _, ...rest } = options;
  const panelFile = 'panel' in options ? options.panel : panel;
  const server = await startServer({
    stateDir: join(dir, 'state'),
    overwriteConfig: true,
    management: { key: 'panel-test-key' },
    ...rest,
    onLog: (log: LogLine) => lines.push(log.line),
    [internalCommand]: { path: process.execPath, args: [FAKE], ...(panelFile === undefined ? {} : { panel: panelFile }) },
  } as unknown as StartServerOptions);
  try {
    const staticPath = lines.map((l) => /^MANAGEMENT_STATIC_PATH (.+)$/.exec(l)?.[1]).find(Boolean);
    const management = parseYaml(await readFile(server.configPath, 'utf8')).management ?? {};
    return { staticPath, management, stateDir: server.stateDir };
  } finally {
    await server.stop();
  }
}

describe('pinned control panel', () => {
  it('serves a copy in stateDir and turns off the panel download', async () => {
    const { staticPath, management, stateDir } = await start({});
    expect(staticPath).toBe(join(stateDir, 'static', 'management.html'));
    expect(await readFile(staticPath!, 'utf8')).toContain('pinned panel');
    expect(management['disable-auto-update-panel']).toBe(true);
    expect(management['disable-control-panel']).toBeUndefined();
  });

  it('is not used without a known key, where the panel is off', async () => {
    const { staticPath, management } = await start({ management: undefined as never });
    expect(management['disable-control-panel']).toBe(true);
    expect(staticPath).toBeUndefined();
  });

  it('leaves the panel to CPA when the caller chose its source', async () => {
    for (const options of [
      { config: { management: { 'disable-auto-update-panel': false } } },
      { config: { management: { 'panel-github-repository': 'https://github.com/me/panel' } } },
      { env: { MANAGEMENT_STATIC_PATH: join(dir, 'mine.html') } },
    ] satisfies Start[]) {
      const { staticPath, management } = await start(options);
      expect(staticPath === undefined || staticPath === join(dir, 'mine.html')).toBe(true);
      expect(management['disable-auto-update-panel'] ?? false).toBe(false);
    }
  });

  it('does nothing when the package has no panel', async () => {
    const { staticPath, management } = await start({ panel: undefined });
    expect(staticPath).toBeUndefined();
    expect(management['disable-auto-update-panel']).toBeUndefined();
  });

  it('does not touch a configPath config', async () => {
    const configPath = join(dir, 'own.yaml');
    const reservation = await findFreePort('127.0.0.1');
    const port = reservation.port;
    await reservation.release();
    const text = `config-version: 8\nserver:\n  host: 127.0.0.1\n  port: ${port}\nmanagement:\n  disable-auto-update-panel: true\n`;
    await writeFile(configPath, text);
    const lines: string[] = [];
    const server = await startServer({
      configPath,
      onLog: (log: LogLine) => lines.push(log.line),
      [internalCommand]: { path: process.execPath, args: [FAKE], panel },
    } as unknown as StartServerOptions);
    await server.stop();
    expect(lines.some((l) => l.startsWith('MANAGEMENT_STATIC_PATH'))).toBe(false);
    expect(await readFile(configPath, 'utf8')).toBe(text);
  });
});
