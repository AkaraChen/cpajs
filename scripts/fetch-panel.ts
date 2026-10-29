/**
 * Downloads the pinned web control panel into assets/management.html and checks
 * its sha256. Already-present files with the right digest are kept.
 *
 *   node scripts/fetch-panel.ts
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CPA_PANEL } from '../packages/cpa/src/server/cpa-version.ts';
import { PANEL_FILE } from '../packages/cpa/src/server/panel.ts';
import { fail, log } from './lib.ts';

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

export async function fetchPanel(): Promise<string> {
  if (existsSync(PANEL_FILE) && sha256(await readFile(PANEL_FILE)) === CPA_PANEL.sha256) return PANEL_FILE;
  log(`downloading control panel ${CPA_PANEL.version}`);
  const res = await fetch(CPA_PANEL.url);
  if (!res.ok) fail(`GET ${CPA_PANEL.url}: ${res.status} ${res.statusText}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const actual = sha256(data);
  if (actual !== CPA_PANEL.sha256) fail(`control panel ${CPA_PANEL.version} has sha256 ${actual}, expected ${CPA_PANEL.sha256}`);
  await mkdir(dirname(PANEL_FILE), { recursive: true });
  await writeFile(`${PANEL_FILE}.tmp`, data);
  await rename(`${PANEL_FILE}.tmp`, PANEL_FILE);
  return PANEL_FILE;
}

if (import.meta.main) {
  log(`control panel ready at ${await fetchPanel()} (${CPA_PANEL.version})`);
}
