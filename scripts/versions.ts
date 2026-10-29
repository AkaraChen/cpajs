/**
 * Keeps every published workspace package on one version.
 *
 *   node scripts/versions.ts                    # fail unless all packages share a version
 *   node scripts/versions.ts --expect 0.1.0-rc.8  # also require that version (the release tag)
 *   node scripts/versions.ts --set 0.1.0-rc.8     # bump every package (for a release PR)
 *
 * The platform packages take the main package's version when they are
 * assembled, so they are not listed here.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ROOT, WORKSPACE_PACKAGES, args, fail, log } from './lib.ts';

async function manifest(dir: string): Promise<{ path: string; text: string; json: { name: string; version: string } }> {
  const path = join(dir, 'package.json');
  const text = await readFile(path, 'utf8');
  return { path, text, json: JSON.parse(text) as { name: string; version: string } };
}

if (import.meta.main) {
  const values = args({ expect: { type: 'string' }, set: { type: 'string' } });
  const manifests = await Promise.all(WORKSPACE_PACKAGES.map((pkg) => manifest(pkg.dir)));
  for (const [i, m] of manifests.entries()) {
    if (m.json.name !== WORKSPACE_PACKAGES[i]!.name) fail(`${relative(ROOT, m.path)} is ${m.json.name}, expected ${WORKSPACE_PACKAGES[i]!.name}`);
  }

  if (values.set !== undefined) {
    const version = values.set.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`not a semver version: ${values.set}`);
    for (const m of manifests) {
      // Replace only the version field so the rest of the file keeps its formatting.
      const next = m.text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
      if (next === m.text && m.json.version !== version) fail(`could not find a version field in ${relative(ROOT, m.path)}`);
      await writeFile(m.path, next);
      log(`${m.json.name} ${m.json.version} → ${version}`);
    }
  } else {
    const versions = new Set(manifests.map((m) => m.json.version));
    if (versions.size !== 1) fail(`packages are not on one version: ${manifests.map((m) => `${m.json.name}@${m.json.version}`).join(', ')}`);
    const [version] = versions;
    const expected = values.expect?.replace(/^v/, '');
    if (expected !== undefined && version !== expected) fail(`packages are at ${version}, expected ${expected}`);
    log(`${manifests.map((m) => m.json.name).join(', ')} are all at ${version}`);
  }
}
