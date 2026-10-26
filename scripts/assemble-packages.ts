/**
 * Assembles the per-platform npm packages from built binaries.
 *
 *   node scripts/assemble-packages.ts [--bin-dir dist-bin] [--out dist-npm] [--require-all]
 *
 * For every target found in --bin-dir (all targets with --require-all) this
 * writes <out>/<target>/ with package.json, bin/, BUILD-INFO.json, LICENSE and
 * README.md. scripts/pack.ts turns them into tarballs.
 */
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CPA_RELEASE } from '../src/server/cpa-version.ts';
import { TARGETS, binaryName, packageName, type Target } from '../src/server/targets.ts';
import { fetchSource } from './fetch-source.ts';
import { DEFAULT_BIN_DIR, DEFAULT_NPM_DIR, ROOT, args, fail, log, sha256File, type BuildInfo } from './lib.ts';

interface RootManifest {
  version: string;
  repository: unknown;
}

function platformManifest(target: Target, version: string, repository: unknown) {
  return {
    name: packageName(target),
    version,
    description: `CLIProxyAPI ${CPA_RELEASE.version} binary for ${target.id} (${target.build === 'plugin' ? 'with plugin support' : 'portable, no plugins'}), used by cpa-js`,
    license: 'MIT',
    repository,
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc ? { libc: [target.libc] } : {}),
    files: ['bin', 'BUILD-INFO.json'],
    preferUnplugged: true,
    cpa: { version: CPA_RELEASE.version, commit: CPA_RELEASE.commit, build: target.build, verification: target.verification },
  };
}

function readme(target: Target, info: BuildInfo): string {
  return `# ${packageName(target)}

Prebuilt [CLIProxyAPI](${CPA_RELEASE.repository}) ${CPA_RELEASE.tag} for \`${target.id}\`.
Install [\`cpa-js\`](https://www.npmjs.com/package/cpa-js) instead; it depends on this package
through \`optionalDependencies\` and picks the right one for your platform.

| | |
| --- | --- |
| Source | ${CPA_RELEASE.repository}/tree/${CPA_RELEASE.commit} |
| Go | ${info.go.version} (\`GOOS=${info.go.goos} GOARCH=${info.go.goarch}\`) |
| Build | ${target.build === 'plugin' ? 'CGO enabled, dynamic library plugins supported' : 'CGO disabled, static, no dynamic library plugins'} |
| Verification | ${target.verification} |
| SHA-256 | \`${info.sha256}\` |
${target.notes ? `\n${target.notes}\n` : ''}
CLIProxyAPI is MIT licensed; see LICENSE.
`;
}

if (import.meta.main) {
  const values = args({
    'bin-dir': { type: 'string' },
    out: { type: 'string' },
    'require-all': { type: 'boolean' },
    source: { type: 'string' },
  });
  const binDir = values['bin-dir'] ?? DEFAULT_BIN_DIR;
  const outDir = values.out ?? DEFAULT_NPM_DIR;
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as RootManifest;
  const license = join(await fetchSource(values.source), 'LICENSE');

  const present = TARGETS.filter((t) => existsSync(join(binDir, t.id, binaryName(t))));
  const missing = TARGETS.filter((t) => !present.includes(t));
  if (values['require-all'] && missing.length) fail(`missing binaries for: ${missing.map((t) => t.id).join(', ')}`);
  if (present.length === 0) fail(`no binaries found in ${binDir}`);

  for (const target of present) {
    const src = join(binDir, target.id);
    const info = JSON.parse(await readFile(join(src, 'BUILD-INFO.json'), 'utf8')) as BuildInfo;
    const binary = join(src, binaryName(target));
    if ((await sha256File(binary)) !== info.sha256) fail(`${target.id}: checksum does not match BUILD-INFO.json`);
    if (info.cpa.commit !== CPA_RELEASE.commit) fail(`${target.id}: built from ${info.cpa.commit}, expected ${CPA_RELEASE.commit}`);

    const dir = join(outDir, target.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'bin'), { recursive: true });
    const dest = join(dir, 'bin', binaryName(target));
    await copyFile(binary, dest);
    await chmod(dest, 0o755);
    await copyFile(join(src, 'BUILD-INFO.json'), join(dir, 'BUILD-INFO.json'));
    await copyFile(license, join(dir, 'LICENSE'));
    await writeFile(join(dir, 'README.md'), readme(target, info));
    await writeFile(join(dir, 'package.json'), `${JSON.stringify(platformManifest(target, root.version, root.repository), null, 2)}\n`);
    log(`assembled ${packageName(target)}@${root.version} in ${dir}`);
  }
  if (missing.length) log(`skipped (not built): ${missing.map((t) => t.id).join(', ')}`);

}
