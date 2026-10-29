/**
 * Checks out the pinned CLIProxyAPI source and verifies the commit.
 *
 *   node scripts/fetch-source.ts [--dir <path>]
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CPA_RELEASE } from '../packages/cpa/src/server/cpa-version.ts';
import { DEFAULT_SOURCE_DIR, args, fail, log, run } from './lib.ts';

export async function fetchSource(dir = DEFAULT_SOURCE_DIR): Promise<string> {
  if (!existsSync(dir)) {
    await mkdir(dirname(dir), { recursive: true });
    log(`cloning ${CPA_RELEASE.repository} ${CPA_RELEASE.tag} into ${dir}`);
    await run('git', [
      '-c',
      'advice.detachedHead=false',
      'clone',
      '--depth',
      '1',
      '--branch',
      CPA_RELEASE.tag,
      `${CPA_RELEASE.repository}.git`,
      dir,
    ]);
  }
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir, capture: true })).trim();
  if (head !== CPA_RELEASE.commit) {
    fail(`${dir} is at ${head}, expected ${CPA_RELEASE.tag} = ${CPA_RELEASE.commit}. The tag may have moved upstream.`);
  }
  const dirty = (await run('git', ['status', '--porcelain'], { cwd: dir, capture: true })).trim();
  if (dirty) fail(`${dir} has local modifications:\n${dirty}`);
  return dir;
}

if (import.meta.main) {
  const values = args({ dir: { type: 'string' } });
  const dir = await fetchSource(values.dir);
  log(`source ready at ${dir} (${CPA_RELEASE.commit})`);
}
