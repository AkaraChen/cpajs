/**
 * Builds the pinned CLIProxyAPI for one or more targets.
 *
 *   node scripts/build-binary.ts --target linux-x64-musl[,win32-ia32] [--source <dir>] [--out <dir>]
 *   node scripts/build-binary.ts --all-portable
 *   node scripts/build-binary.ts --target <id> --launcher-only   # add cpa-launcher to an existing build
 *
 * Output: <out>/<target>/{cli-proxy-api[.exe], BUILD-INFO.json}
 *
 * Portable targets cross-compile anywhere with CGO disabled. Plugin targets
 * follow the upstream release workflow:
 *   - linux glibc: built in a manylinux2014 container on a host of the same CPU (glibc 2.17 baseline)
 *   - freebsd: cross-compiled with clang against a FreeBSD 14 sysroot (needs clang + lld)
 *   - darwin / windows: built natively on a host of the same OS and CPU
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CPA_RELEASE } from '../packages/cpa/src/server/cpa-version.ts';
import { LAUNCHER_NAME, TARGETS, binaryName, hasLauncher, packageName, type Target } from '../packages/cpa/src/server/targets.ts';
import { fetchSource } from './fetch-source.ts';
import { CACHE_DIR, DEFAULT_BIN_DIR, ROOT, args, fail, log, run, selectTargets, sha256File, type BuildInfo } from './lib.ts';

const FLAGS = ['-trimpath', '-buildvcs=false'];
const LDFLAGS = [
  '-s',
  '-w',
  `-X main.Version=${CPA_RELEASE.version}`,
  `-X main.Commit=${CPA_RELEASE.commit.slice(0, 7)}`,
  `-X main.BuildDate=${CPA_RELEASE.commitDate}`,
].join(' ');

const MANYLINUX: Record<string, string> = {
  amd64: 'quay.io/pypa/manylinux2014_x86_64',
  arm64: 'quay.io/pypa/manylinux2014_aarch64',
};
const FREEBSD_RELEASE = '14.4-RELEASE';
const FREEBSD_CLANG: Record<string, string> = { amd64: 'x86_64-unknown-freebsd14', arm64: 'aarch64-unknown-freebsd14' };

const HOST_GOARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64', ia32: '386' };

function goEnv(target: Target): Record<string, string> {
  return {
    GOOS: target.goos,
    GOARCH: target.goarch,
    CGO_ENABLED: target.build === 'plugin' ? '1' : '0',
    ...target.goenv,
  };
}

async function goBuild(source: string, output: string, env: Record<string, string>): Promise<void> {
  await run('go', ['build', ...FLAGS, `-ldflags=${LDFLAGS}`, '-o', output, './cmd/server/'], {
    cwd: source,
    env: {
      ...process.env,
      // Use the exact toolchain from go.mod unless the caller chose one.
      GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? `go${CPA_RELEASE.goVersion}`,
      ...env,
    },
  });
}

async function buildLinuxGlibc(source: string, target: Target, output: string): Promise<void> {
  const hostArch = HOST_GOARCH[arch()];
  if (platform() !== 'linux' || hostArch !== target.goarch) {
    fail(`${target.id} must be built on a linux/${target.goarch} host (this is ${platform()}/${arch()}).`);
  }
  const image = MANYLINUX[target.goarch];
  if (!image) fail(`No manylinux image for ${target.goarch}.`);
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const name = basename(output);
  const script = [
    'set -euo pipefail',
    `curl -fsSL https://go.dev/dl/go${CPA_RELEASE.goVersion}.linux-${target.goarch}.tar.gz | tar -C /tmp -xz`,
    'export PATH=/tmp/go/bin:$PATH GOTOOLCHAIN=local HOME=/tmp GOCACHE=/tmp/gocache GOMODCACHE=/tmp/gomod',
    `CGO_ENABLED=1 GOOS=linux GOARCH=${target.goarch} go build ${FLAGS.join(' ')} -ldflags="${LDFLAGS}" -o "/out/${name}" ./cmd/server/`,
    `chown ${uid}:${gid} "/out/${name}"`,
  ].join('\n');
  await run('docker', ['run', '--rm', '-v', `${source}:/src:ro`, '-v', `${dirname(output)}:/out`, '-w', '/src', image, 'bash', '-c', script]);
}

async function freebsdSysroot(goarch: string): Promise<string> {
  const dir = join(CACHE_DIR, `freebsd-sysroot-${FREEBSD_RELEASE}-${goarch}`);
  if (existsSync(join(dir, 'usr', 'include'))) return dir;
  await mkdir(dir, { recursive: true });
  const archive = join(CACHE_DIR, `freebsd-base-${FREEBSD_RELEASE}-${goarch}.txz`);
  const urls = [
    `https://download.freebsd.org/releases/${goarch}/${FREEBSD_RELEASE}/base.txz`,
    `https://archive.freebsd.org/old-releases/${goarch}/${FREEBSD_RELEASE}/base.txz`,
  ];
  let downloaded = false;
  for (const url of urls) {
    try {
      log(`downloading FreeBSD sysroot ${url}`);
      await run('curl', ['-fsSL', '--retry', '3', '-o', archive, url]);
      downloaded = true;
      break;
    } catch {
      log(`download failed: ${url}`);
    }
  }
  if (!downloaded) fail('Could not download a FreeBSD base.txz for the sysroot.');
  // Only headers and libraries are needed to link.
  await run('tar', ['-xf', archive, '-C', dir, './usr/include', './usr/lib', './lib']);
  await rm(archive, { force: true });
  return dir;
}

/**
 * Builds cpa-launcher (launcher/, pure Go, CGO disabled) for a target. It
 * cross-compiles from any host and never needs CPA's source.
 */
export async function buildLauncher(target: Target, dir: string): Promise<BuildInfo['launcher']> {
  if (!hasLauncher(target)) return undefined;
  const output = join(dir, LAUNCHER_NAME);
  await run('go', ['build', ...FLAGS, '-ldflags=-s -w', '-o', output, '.'], {
    cwd: join(ROOT, 'launcher'),
    env: {
      ...process.env,
      GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? `go${CPA_RELEASE.goVersion}`,
      GOOS: target.goos,
      GOARCH: target.goarch,
      CGO_ENABLED: '0',
      ...target.goenv,
    },
  });
  log(`built ${output}`);
  return { file: LAUNCHER_NAME, sha256: await sha256File(output), size: (await stat(output)).size };
}

async function buildOne(source: string, target: Target, outDir: string): Promise<BuildInfo> {
  const dir = join(outDir, target.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const output = join(dir, binaryName(target));
  const env = goEnv(target);
  log(`building ${target.id} (${target.goos}/${target.goarch}, ${target.build})`);

  if (target.build === 'portable') {
    await goBuild(source, output, env);
  } else if (target.goos === 'linux') {
    await buildLinuxGlibc(source, target, output);
  } else if (target.goos === 'freebsd') {
    const sysroot = await freebsdSysroot(target.goarch);
    await goBuild(source, output, {
      ...env,
      CC: `clang --target=${FREEBSD_CLANG[target.goarch]} --sysroot=${sysroot}`,
      CGO_LDFLAGS: '-fuse-ld=lld',
    });
  } else {
    if (platform() !== target.os || HOST_GOARCH[arch()] !== target.goarch) {
      fail(`${target.id} uses CGO and must be built natively on ${target.os}/${target.cpu}.`);
    }
    await goBuild(source, output, env);
  }

  const launcher = await buildLauncher(target, dir);
  const info: BuildInfo = {
    ...(launcher === undefined ? {} : { launcher }),
    target: target.id,
    package: packageName(target),
    binary: binaryName(target),
    sha256: await sha256File(output),
    size: (await stat(output)).size,
    cpa: CPA_RELEASE,
    go: { version: CPA_RELEASE.goVersion, goos: target.goos, goarch: target.goarch, env },
    build: target.build,
    cgo: target.build === 'plugin',
    plugins: target.build === 'plugin',
    modelCatalogs: 'embedded-at-pinned-commit',
    flags: FLAGS,
    ldflags: LDFLAGS,
    toolchain: `go${CPA_RELEASE.goVersion}`,
    verification: target.verification,
  };
  await writeFile(join(dir, 'BUILD-INFO.json'), `${JSON.stringify(info, null, 2)}\n`);
  log(`built ${output} sha256=${info.sha256}`);
  return info;
}

if (import.meta.main) {
  const values = args({
    target: { type: 'string' },
    all: { type: 'boolean' },
    'all-portable': { type: 'boolean' },
    source: { type: 'string' },
    out: { type: 'string' },
    'launcher-only': { type: 'boolean' },
  });
  const targets = values['all-portable'] ? TARGETS.filter((t) => t.build === 'portable') : selectTargets(values);
  const outDir = values.out ?? DEFAULT_BIN_DIR;
  if (values['launcher-only']) {
    // Add cpa-launcher to existing builds without rebuilding CPA.
    for (const target of targets) {
      const dir = join(outDir, target.id);
      const infoPath = join(dir, 'BUILD-INFO.json');
      if (!existsSync(infoPath)) fail(`${target.id}: no existing build in ${dir}`);
      const info = JSON.parse(await readFile(infoPath, 'utf8')) as BuildInfo;
      const launcher = await buildLauncher(target, dir);
      await writeFile(infoPath, `${JSON.stringify(launcher === undefined ? info : { ...info, launcher }, null, 2)}\n`);
    }
  } else {
    const source = await fetchSource(values.source);
    for (const target of targets) await buildOne(source, target, outDir);
  }
}
