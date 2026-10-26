/**
 * Platform targets for the prebuilt CLIProxyAPI binaries.
 *
 * This list is the single source of truth for both the runtime binary lookup
 * and the build/assembly scripts, so it must stay free of Node-only imports.
 */

/** How a target binary is produced. */
export type TargetBuild =
  /** CGO enabled, dynamic library plugins supported (matches the upstream default build). */
  | 'plugin'
  /** CGO disabled, statically linked, no dynamic library plugins (upstream "no-plugin"). */
  | 'portable';

/** The strongest verification CI performs for a target. */
export type TargetVerification =
  /** Started natively on a matching runner and smoke-tested over HTTP. */
  | 'native'
  /** Started under QEMU user-mode emulation and smoke-tested over HTTP. */
  | 'emulated'
  /** Only cross-compiled; the binary is never executed in CI. */
  | 'cross-compiled';

export interface Target {
  /** Package suffix, e.g. `linux-x64-gnu` → `@cpajs/linux-x64-gnu`. */
  readonly id: string;
  /** `process.platform` value. */
  readonly os: NodeJS.Platform;
  /** `process.arch` value. */
  readonly cpu: NodeJS.Architecture;
  /** npm `libc` constraint. Omitted for static binaries that run on any libc. */
  readonly libc?: 'glibc' | 'musl';
  readonly goos: string;
  readonly goarch: string;
  /** Extra Go environment, e.g. `GOARM`. */
  readonly goenv?: Readonly<Record<string, string>>;
  readonly build: TargetBuild;
  readonly verification: TargetVerification;
  /** Human-readable caveats shown in docs and errors. */
  readonly notes?: string;
}

export const NPM_SCOPE = '@cpajs';

export const TARGETS: readonly Target[] = [
  { id: 'darwin-x64', os: 'darwin', cpu: 'x64', goos: 'darwin', goarch: 'amd64', build: 'plugin', verification: 'native' },
  { id: 'darwin-arm64', os: 'darwin', cpu: 'arm64', goos: 'darwin', goarch: 'arm64', build: 'plugin', verification: 'native' },

  { id: 'win32-x64', os: 'win32', cpu: 'x64', goos: 'windows', goarch: 'amd64', build: 'plugin', verification: 'native' },
  { id: 'win32-arm64', os: 'win32', cpu: 'arm64', goos: 'windows', goarch: 'arm64', build: 'plugin', verification: 'native' },
  {
    id: 'win32-ia32',
    os: 'win32',
    cpu: 'ia32',
    goos: 'windows',
    goarch: '386',
    build: 'portable',
    verification: 'native',
    notes: 'Not built upstream. Smoke-tested under WOW64 on an x64 runner.',
  },

  { id: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc', goos: 'linux', goarch: 'amd64', build: 'plugin', verification: 'native', notes: 'Requires glibc 2.17 or newer.' },
  { id: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc', goos: 'linux', goarch: 'arm64', build: 'plugin', verification: 'native', notes: 'Requires glibc 2.17 or newer.' },
  { id: 'linux-x64-musl', os: 'linux', cpu: 'x64', libc: 'musl', goos: 'linux', goarch: 'amd64', build: 'portable', verification: 'native' },
  { id: 'linux-arm64-musl', os: 'linux', cpu: 'arm64', libc: 'musl', goos: 'linux', goarch: 'arm64', build: 'portable', verification: 'native' },
  {
    id: 'linux-arm',
    os: 'linux',
    cpu: 'arm',
    goos: 'linux',
    goarch: 'arm',
    goenv: { GOARM: '7' },
    build: 'portable',
    verification: 'emulated',
    notes: 'ARMv7 or newer (GOARM=7). Static binary for both glibc and musl. Not built upstream.',
  },
  { id: 'linux-ia32', os: 'linux', cpu: 'ia32', goos: 'linux', goarch: '386', build: 'portable', verification: 'native', notes: 'Not built upstream.' },
  { id: 'linux-riscv64', os: 'linux', cpu: 'riscv64', goos: 'linux', goarch: 'riscv64', build: 'portable', verification: 'emulated', notes: 'Not built upstream.' },
  { id: 'linux-ppc64', os: 'linux', cpu: 'ppc64', goos: 'linux', goarch: 'ppc64le', build: 'portable', verification: 'emulated', notes: 'Little-endian ppc64le only. Not built upstream.' },
  { id: 'linux-s390x', os: 'linux', cpu: 's390x', goos: 'linux', goarch: 's390x', build: 'portable', verification: 'emulated', notes: 'Not built upstream.' },
  { id: 'linux-loong64', os: 'linux', cpu: 'loong64', goos: 'linux', goarch: 'loong64', build: 'portable', verification: 'emulated', notes: 'Not built upstream.' },
  {
    id: 'linux-mips',
    os: 'linux',
    cpu: 'mips',
    goos: 'linux',
    goarch: 'mips',
    goenv: { GOMIPS: 'softfloat' },
    build: 'portable',
    verification: 'emulated',
    notes: 'Big-endian 32-bit MIPS, soft float. Not built upstream.',
  },
  {
    id: 'linux-mipsel',
    os: 'linux',
    cpu: 'mipsel',
    goos: 'linux',
    goarch: 'mipsle',
    goenv: { GOMIPS: 'softfloat' },
    build: 'portable',
    verification: 'emulated',
    notes: 'Little-endian 32-bit MIPS, soft float. Not built upstream.',
  },

  { id: 'freebsd-x64', os: 'freebsd', cpu: 'x64', goos: 'freebsd', goarch: 'amd64', build: 'plugin', verification: 'cross-compiled', notes: 'Cross-compiled against a FreeBSD 14 sysroot, as upstream does.' },
  { id: 'freebsd-arm64', os: 'freebsd', cpu: 'arm64', goos: 'freebsd', goarch: 'arm64', build: 'portable', verification: 'cross-compiled' },
  { id: 'freebsd-ia32', os: 'freebsd', cpu: 'ia32', goos: 'freebsd', goarch: '386', build: 'portable', verification: 'cross-compiled', notes: 'Not built upstream.' },

  { id: 'openbsd-x64', os: 'openbsd', cpu: 'x64', goos: 'openbsd', goarch: 'amd64', build: 'portable', verification: 'cross-compiled', notes: 'Not built upstream.' },
  { id: 'openbsd-arm64', os: 'openbsd', cpu: 'arm64', goos: 'openbsd', goarch: 'arm64', build: 'portable', verification: 'cross-compiled', notes: 'Not built upstream.' },
  { id: 'netbsd-x64', os: 'netbsd', cpu: 'x64', goos: 'netbsd', goarch: 'amd64', build: 'portable', verification: 'cross-compiled', notes: 'Not built upstream.' },
];

/**
 * Node platforms deliberately not covered, with the reason. Checked by
 * cross-compiling the pinned source with CGO disabled.
 */
export const UNSUPPORTED_PLATFORMS: Readonly<Record<string, string>> = {
  'android-*': 'Link fails: github.com/wlynxg/anet references net.zoneCache, which Go no longer allows.',
  'sunos-x64': 'Compile fails: syscall.Flock is undefined on solaris/illumos; pion/transport needs SO_REUSEPORT.',
  'aix-ppc64': 'Compile fails: syscall.Flock is undefined on aix.',
  'linux-mips64el': 'No matching Node.js process.arch value.',
  'haiku-*': 'Not a Go target.',
  'cygwin-*': 'Use the win32 packages.',
};

export function packageName(target: Target): string {
  return `${NPM_SCOPE}/${target.id}`;
}

export function binaryName(target: Pick<Target, 'os'>): string {
  return target.os === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
}
