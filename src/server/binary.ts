import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CpaBinaryError } from './errors.ts';
import { TARGETS, UNSUPPORTED_PLATFORMS, binaryName, packageName, type Target } from './targets.ts';

const require = createRequire(import.meta.url);

export type Libc = 'glibc' | 'musl';

export interface HostPlatform {
  os: NodeJS.Platform;
  cpu: NodeJS.Architecture;
  /** Only meaningful on Linux. */
  libc?: Libc;
}

export interface ResolvedBinary {
  path: string;
  /** The platform package the binary came from, or undefined for `binaryPath` overrides. */
  packageName?: string;
  target?: Target;
}

/** Detects the C library of the running Linux system. */
export function detectLibc(): Libc | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header) return report.header.glibcVersionRuntime ? 'glibc' : 'musl';
  } catch {
    // Fall through to the filesystem probe; some runtimes do not implement process.report.
  }
  try {
    if (readdirSync('/lib').some((name) => name.startsWith('ld-musl-'))) return 'musl';
  } catch {
    // Ignore unreadable /lib.
  }
  return 'glibc';
}

export function currentPlatform(): HostPlatform {
  const libc = detectLibc();
  return libc ? { os: process.platform, cpu: process.arch, libc } : { os: process.platform, cpu: process.arch };
}

/**
 * Returns the targets that can run on a host, best match first.
 *
 * On Linux the libc-specific build is preferred, followed by the static
 * portable build of the other libc, which runs anywhere on the same CPU.
 */
export function candidateTargets(host: HostPlatform): Target[] {
  const matches = TARGETS.filter((t) => t.os === host.os && t.cpu === host.cpu);
  const score = (t: Target): number => {
    if (t.libc === undefined || t.libc === host.libc) return 0;
    return t.build === 'portable' ? 1 : Number.POSITIVE_INFINITY;
  };
  return matches.filter((t) => Number.isFinite(score(t))).sort((a, b) => score(a) - score(b));
}

function ensureExecutable(path: string, source: string): void {
  if (!existsSync(path)) {
    throw new CpaBinaryError('missing', `CLIProxyAPI binary not found at ${path} (${source}).`);
  }
  if (!statSync(path).isFile()) {
    throw new CpaBinaryError('missing', `CLIProxyAPI binary path ${path} is not a file (${source}).`);
  }
  if (process.platform === 'win32') return;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    // Some package managers drop the executable bit on extraction; restore it once.
    try {
      chmodSync(path, 0o755);
      accessSync(path, constants.X_OK);
    } catch {
      throw new CpaBinaryError('not-executable', `CLIProxyAPI binary at ${path} is not executable (${source}).`);
    }
  }
}

/**
 * Locates the CLIProxyAPI executable.
 *
 * `binaryPath` overrides the lookup. Otherwise the platform package installed
 * through the main package's optionalDependencies is used.
 */
export function resolveBinary(options: { binaryPath?: string; platform?: HostPlatform } = {}): ResolvedBinary {
  if (options.binaryPath) {
    ensureExecutable(options.binaryPath, 'binaryPath option');
    return { path: options.binaryPath };
  }

  const host = options.platform ?? currentPlatform();
  const candidates = candidateTargets(host);
  const hostLabel = `${host.os}-${host.cpu}${host.libc ? ` (${host.libc})` : ''}`;
  if (candidates.length === 0) {
    const supported = TARGETS.map((t) => t.id).join(', ');
    const reason = UNSUPPORTED_PLATFORMS[`${host.os}-${host.cpu}`] ?? UNSUPPORTED_PLATFORMS[`${host.os}-*`];
    throw new CpaBinaryError(
      'unsupported-platform',
      `No prebuilt CLIProxyAPI binary for ${hostLabel}${reason ? ` (${reason})` : ''}. ` +
        `Supported targets: ${supported}. Pass binaryPath to use your own build.`,
    );
  }

  for (const target of candidates) {
    const name = packageName(target);
    let manifest: string;
    try {
      manifest = require.resolve(`${name}/package.json`);
    } catch {
      continue;
    }
    const path = join(dirname(manifest), 'bin', binaryName(target));
    ensureExecutable(path, name);
    return { path, packageName: name, target };
  }

  const expected = candidates.map(packageName).join(' or ');
  throw new CpaBinaryError(
    'package-not-installed',
    `The CLIProxyAPI binary package for ${hostLabel} is not installed (expected ${expected}). ` +
      'It is an optional dependency of @cpajs/cpa; reinstall without --no-optional / --omit=optional, ' +
      'make sure your lockfile was not created on another platform without it, or pass binaryPath.',
  );
}
