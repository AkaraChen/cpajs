# Compatibility

## Versions

The `@cpajs/cpa` version and the bundled CLIProxyAPI version are tracked separately.

| @cpajs/cpa | CLIProxyAPI | Commit | Go | Management API | Control panel |
| --- | --- | --- | --- | --- | --- |
| 0.0.x – 0.1.0-rc.3 | v8.0.43 | `307803510bce87f986fcf7b1a84190f105c7b4aa` | 1.26.10 | `/v8/management` | not bundled (CPA downloads the latest) |
| 0.1.0-rc.4 – 0.1.0-rc.5 | v8.0.43 | `307803510bce87f986fcf7b1a84190f105c7b4aa` | 1.26.10 | `/v8/management` | v1.26.7 |

The pinned release lives in [`src/server/cpa-version.ts`](../src/server/cpa-version.ts) and is exported at
runtime as `CPA_RELEASE`. The client also works with other v8.x servers when the routes it calls exist there.
Use `client.server.info()` to check which version a server runs.

### Upgrading the pinned CLIProxyAPI

1. Update `CPA_RELEASE` (tag, commit, commit date, Go version from `go.mod`), and `CPA_PANEL` to the
   [control panel release](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases) that was
   current at that commit (version, URL, and the `sha256` digest GitHub lists for `management.html`). Re-check
   `internal/managementasset/updater.go` for `MANAGEMENT_STATIC_PATH` and `disable-auto-update-panel`.
2. Diff `internal/api/server_management_v8.go` and the handlers in `internal/api/handlers/management/`, as well as
   `internal/config/` for config schema changes, between the old and new tag. Update the types,
   the client methods and [`api-coverage.md`](api-coverage.md).
3. Re-check the CLI flags in `cmd/server/main.go` that `startServer` relies on (`-config`), the
   `MANAGEMENT_PASSWORD` variable, bcrypt acceptance of `management.secret-key`, `/healthz`, and the exit code
   when the bind fails. cpajs detects a port conflict by re-probing the port after an early exit, not by matching
   the error text.
4. Run `node scripts/build-binary.ts --all-portable`, `pnpm panel:fetch`, the unit tests, and `pnpm test:e2e`
   against a fresh build.
5. Bump the `@cpajs/cpa` version. Platform packages always share the main package version.

## Versioning policy

- `@cpajs/cpa` follows semver. Before 1.0, a minor version bump (0.x → 0.y) may break; patch and prerelease
  bumps within an alpha series may also break, and every break is listed in [CHANGELOG.md](../CHANGELOG.md)
  under **Breaking**, with steps in [migration.md](migration.md).
- From 1.0 on, these count as breaking and need a major version:
  - removing or renaming an export, option, method or property;
  - changing the default security behaviour (for example how the management key reaches CPA);
  - changing when cpajs writes or overwrites files;
  - dropping a runtime version, or a platform package that was published before.
- Updates to the bundled CLIProxyAPI ship as a minor version. They can change upstream behaviour or the
  management API surface; those changes are summarised in the changelog. The client types follow the bundled
  version.
- Platform packages always share the main package version. Never mix versions.

## Runtimes

The package is ESM-only (`"type": "module"`, `import` exports, no CommonJS build) and needs Node.js 22 or newer
(`engines.node: ">=22"`) or a current Bun.


| Runtime | Status |
| --- | --- |
| Node.js 22, 24 | Supported. CI runs unit tests on Linux, macOS and Windows, contract e2e tests against a real binary on Linux and Windows, plus install tests. |
| Bun | Supported. CI runs unit tests under Bun and installs/runs the package with `bun add` + `bun`. |
| Browsers / edge runtimes | `@cpajs/cpa/client` uses only `fetch`, `Headers`, `FormData`, `Blob`, `AbortSignal`, so it works anywhere those exist. `@cpajs/cpa/server` needs Node.js APIs. |

## Platforms

Every target is built from the pinned source. Binary names and sizes are listed in `BUILD-INFO.json` inside each
platform package. **Build**: `plugin` means CGO is on and dynamic library plugins are supported, which matches the
upstream default. `portable` means CGO is off, the binary is static, and there are no plugins (upstream calls this
"no-plugin"). **Verification**: `native` means CI starts the binary on matching hardware and runs HTTP smoke tests,
`emulated` means the same under QEMU user-mode, and `cross-compiled` means the binary is only built.

| Package | OS | CPU | libc | Build | Verification | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `@cpajs/darwin-x64` | macOS | x64 | – | plugin | native | |
| `@cpajs/darwin-arm64` | macOS | arm64 | – | plugin | native | |
| `@cpajs/win32-x64` | Windows | x64 | – | plugin | native | |
| `@cpajs/win32-arm64` | Windows | arm64 | – | plugin | native | |
| `@cpajs/win32-ia32` | Windows | ia32 | – | portable | native (WOW64) | not built upstream |
| `@cpajs/linux-x64-gnu` | Linux | x64 | glibc ≥ 2.17 | plugin | native | manylinux2014 |
| `@cpajs/linux-arm64-gnu` | Linux | arm64 | glibc ≥ 2.17 | plugin | native | manylinux2014 |
| `@cpajs/linux-x64-musl` | Linux | x64 | musl | portable | native | |
| `@cpajs/linux-arm64-musl` | Linux | arm64 | musl | portable | native | |
| `@cpajs/linux-arm` | Linux | arm (ARMv7+) | any | portable | emulated | `GOARM=7`; not built upstream |
| `@cpajs/linux-ia32` | Linux | ia32 | any | portable | native | not built upstream |
| `@cpajs/linux-riscv64` | Linux | riscv64 | any | portable | emulated | not built upstream |
| `@cpajs/linux-ppc64` | Linux | ppc64le | any | portable | emulated | little-endian only |
| `@cpajs/linux-s390x` | Linux | s390x | any | portable | emulated | not built upstream |
| `@cpajs/linux-loong64` | Linux | loong64 | any | portable | emulated | not built upstream |
| `@cpajs/linux-mips` | Linux | mips | any | portable | emulated | soft float |
| `@cpajs/linux-mipsel` | Linux | mipsel | any | portable | emulated | soft float |
| `@cpajs/freebsd-x64` | FreeBSD | x64 | – | plugin | cross-compiled | FreeBSD 14 sysroot, as upstream |
| `@cpajs/freebsd-arm64` | FreeBSD | arm64 | – | portable | cross-compiled | |
| `@cpajs/freebsd-ia32` | FreeBSD | ia32 | – | portable | cross-compiled | not built upstream |
| `@cpajs/openbsd-x64` | OpenBSD | x64 | – | portable | cross-compiled | not built upstream |
| `@cpajs/openbsd-arm64` | OpenBSD | arm64 | – | portable | cross-compiled | not built upstream |
| `@cpajs/netbsd-x64` | NetBSD | x64 | – | portable | cross-compiled | not built upstream |

### Unsupported

These were checked by cross-compiling the pinned source with CGO disabled.

| Platform | Reason |
| --- | --- |
| Android | Link fails: `github.com/wlynxg/anet` references `net.zoneCache`. |
| Solaris / illumos (`sunos`) | `syscall.Flock` is undefined. `pion/transport` needs `SO_REUSEPORT`. |
| AIX | `syscall.Flock` is undefined. |
| linux mips64le | Builds, but Node.js has no matching `process.arch`. |
| Haiku | Not a Go target. |

On these platforms `startServer` fails with `CpaBinaryError` (`code: 'unsupported-platform'`). Pass `binaryPath`
to use your own build.

### How the right package is installed

The main package lists every platform package in `optionalDependencies`. Each platform package declares `os`, `cpu`
and, for the two glibc/musl pairs, `libc`, so the package manager installs only the matching ones. At runtime
`resolveBinary()` detects the platform and libc (through `process.report`, falling back to looking for
`/lib/ld-musl-*`). It then uses the best installed package. On Linux x64/arm64 it prefers the libc-specific build
and falls back to the static musl build, which also runs on glibc. Package managers that ignore `libc` install both
packages; the extra one is simply unused.

Errors from `resolveBinary` have a `code`:

- `unsupported-platform`: there is no package for this platform.
- `package-not-installed`: the optional dependency was skipped (`--omit=optional`, or a lockfile made on another
  platform).
- `missing`: the binary file is missing.
- `not-executable`: the file is not executable. An executable bit removed by the package manager is restored once
  before this error is thrown.

## Reproducibility

Binaries are built with `-trimpath -buildvcs=false` and the commit date as `main.BuildDate`. They use the model
catalogs embedded at the pinned commit; upstream release CI refreshes the catalogs from `router-for-me/models`
first, and we skip that step. At runtime CPA refreshes its catalogs from the network anyway, unless `-local-model`
is passed. Rebuilding the same target with the same Go toolchain gives the same SHA-256.
