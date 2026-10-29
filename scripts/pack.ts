/**
 * Packs the assembled platform packages, the main package and the other
 * published workspace packages (WORKSPACE_PACKAGES) into tarballs.
 *
 *   node scripts/pack.ts [--npm-dir dist-npm] [--require-all]
 *
 * The main package gets `optionalDependencies` on every assembled platform
 * package at its own version, injected only for the duration of `npm pack`.
 * The committed package.json carries none, so development installs never try
 * to fetch platform packages that are not published yet.
 * Output: <npm-dir>/tarballs/*.tgz, publishable with `npm publish <tgz>`.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TARGETS, packageName } from '../packages/cpa/src/server/targets.ts';
import { fetchPanel } from './fetch-panel.ts';
import { CPA_DIR, DEFAULT_NPM_DIR, WORKSPACE_PACKAGES, args, fail, log, run } from './lib.ts';

if (import.meta.main) {
  const values = args({ 'npm-dir': { type: 'string' }, 'require-all': { type: 'boolean' } });
  const npmDir = values['npm-dir'] ?? DEFAULT_NPM_DIR;
  const out = join(npmDir, 'tarballs');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const shell = process.platform === 'win32';

  const present = TARGETS.filter((t) => existsSync(join(npmDir, t.id, 'package.json')));
  const missing = TARGETS.filter((t) => !present.includes(t));
  if (values['require-all'] && missing.length) fail(`not assembled: ${missing.map((t) => t.id).join(', ')}`);
  if (present.length === 0) fail(`no assembled packages in ${npmDir}`);

  const manifestPath = join(CPA_DIR, 'package.json');
  const original = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(original) as { version: string; optionalDependencies?: Record<string, string> };

  for (const target of present) {
    const dir = join(npmDir, target.id);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { version: string };
    if (pkg.version !== manifest.version) fail(`${packageName(target)} is ${pkg.version}, main package is ${manifest.version}; re-run assemble.`);
    await run('npm', ['pack', '--pack-destination', out], { cwd: dir, shell });
  }

  // The main package ships the pinned control panel; fetchPanel fails on a digest mismatch.
  await fetchPanel();
  // Build before touching package.json: with the injected optionalDependencies, pnpm's
  // pre-run dependency check would refuse to run the prepack script.
  await run('npm', ['run', 'build'], { cwd: CPA_DIR, shell });
  manifest.optionalDependencies = Object.fromEntries(present.map((t) => [packageName(t), manifest.version]));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    await run('npm', ['pack', '--ignore-scripts', '--pack-destination', out], { cwd: CPA_DIR, shell });
  } finally {
    await writeFile(manifestPath, original);
  }

  // The other workspace packages ship as they are, at the same version as the main package.
  const others = WORKSPACE_PACKAGES.filter((pkg) => pkg.dir !== CPA_DIR);
  for (const pkg of others) {
    const { version } = JSON.parse(await readFile(join(pkg.dir, 'package.json'), 'utf8')) as { version: string };
    if (version !== manifest.version) fail(`${pkg.name} is ${version}, main package is ${manifest.version}; run node scripts/versions.ts --set.`);
    await run('npm', ['run', 'build'], { cwd: pkg.dir, shell });
    await run('npm', ['pack', '--ignore-scripts', '--pack-destination', out], { cwd: pkg.dir, shell });
  }
  log(`packed ${present.length + 1 + others.length} tarballs into ${out}`);
  if (missing.length) log(`main package omits optional dependencies for: ${missing.map((t) => t.id).join(', ')}`);
}
