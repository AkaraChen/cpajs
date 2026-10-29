// The real CPA serves the pinned control panel from stateDir and never fetches one.
// Run `pnpm panel:fetch` first; CI does that before the e2e tests.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CPA_PANEL, startServer } from '../../src/server/index.ts';
import { bundledPanel } from '../../src/server/panel.ts';
import { findBinary } from './helpers.ts';

const binary = findBinary();

describe.skipIf(!binary)('pinned control panel with the real CPA', () => {
  it('serves the pinned management.html without downloading it', async () => {
    expect(bundledPanel(), 'assets/management.html is missing; run pnpm panel:fetch').toBeDefined();
    const lines: string[] = [];
    const server = await startServer({
      binaryPath: binary!,
      localModel: true,
      management: { key: 'e2e-panel-key' },
      onLog: (log) => lines.push(log.line),
    });
    try {
      const res = await fetch(new URL('/management.html', server.origin));
      expect(res.status).toBe(200);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(createHash('sha256').update(body).digest('hex')).toBe(CPA_PANEL.sha256);
    } finally {
      await server.stop();
    }
    expect(lines.filter((l) => /management asset|control panel/i.test(l))).toEqual([]);
  });
});
