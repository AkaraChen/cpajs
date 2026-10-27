# Changelog

All notable changes to `@cpajs/cpa`. The bundled CLIProxyAPI version is listed per release; platform packages
(`@cpajs/<target>`) always share the main package version. Upgrading from an alpha? See
[docs/migration.md](docs/migration.md).

## Unreleased

### Added

- `credentials.reconcile({ owner, files, prune? })` aligns a managed set of credential files by owner and
  revision. Uploads carry a reserved `x-cpajs: { owner, revision }` field; only the revision is compared, so a
  CPA token refresh that rewrites a file does not upload it again. By default files owned by `owner` but no
  longer listed are deleted, while files owned by anyone else are never touched.

## 0.1.0-rc.4

### Added

- The web control panel ships with the package: `management.html` from Cli-Proxy-API-Management-Center v1.26.7,
  checked against its sha256 at build time (`CPA_PANEL`). In a config cpajs manages, CPA serves this copy and
  never downloads a panel (`MANAGEMENT_STATIC_PATH` points at a copy in `<stateDir>/static/`, and
  `disable-auto-update-panel` defaults to `true`). This works offline and avoids upstream's unverified fallback
  mirror. Setting `disable-auto-update-panel: false`, `panel-github-repository` or `MANAGEMENT_STATIC_PATH`
  restores upstream's behaviour. The main package grows by about 1 MB (gzip).

### Changed

- With a generated management key, the managed config defaults `management.disable-control-panel` to `true`.
  Nobody knows the key, so the web panel could never log in, and CPA no longer downloads it from GitHub on
  start. Set `config.management['disable-control-panel']: false` to keep it. An explicit key is unaffected.
- `config.set(path, value)` and `config.patchPath(path, value)` type `value` by `path`: a known path such as
  `'api-keys'` takes `CpaConfigValue<'api-keys'>`, so `CpaConfig` sections pass (they used to fail because
  interfaces have no index signature). Array paths and unknown string paths take any JSON-serialisable value.
  New types: `CpaConfigPath`, `CpaConfigValue`, `ConfigPathValue`, `JsonInput`.

## 0.1.0-rc.3

### Breaking

- **Without `management`, the management API is now enabled with a generated key** (it used to stay disabled).
  The key is random per start; only its bcrypt hash is written, remote management stays off, and the plaintext
  never leaves memory. Pass `management: false` to keep the old behaviour.
- **cpajs warnings no longer go to `onLog`.** They are coded `CpaWarning`s emitted through
  `process.emitWarning` (stderr by default), or to `onWarning` when given. `onLog` carries only CPA's output.

### Added

- Warning governance: every cpajs warning has a code (`noManagementKey`, `managementViaEnvironment`,
  `remoteManagementExposed`, `configReused`, `managementKeyUpdated`), is emitted at most once
  per start, and can be silenced individually with `suppressWarnings: { <code>: true }`. A generated management
  key emits `noManagementKey` by default.
- `server.client(options?)`: a management client bound to the server's origin and key, without exposing the
  key. Available when cpajs knows the key (generated, or `management.key`). It removes the need to invent, store
  and deploy a key when only the host process talks to the management API.

## 0.1.0-rc.2

### Added

- `cpa-launcher`: CPA no longer outlives the host process, even when the host is killed with SIGKILL, crashes, or
  is restarted by `tsx watch` / `nodemon`. On Linux the launcher sets `PR_SET_PDEATHSIG` and execs CPA (no extra
  process). On macOS / BSD it supervises CPA and stops it when the host's pipe closes; `server.pid` is then the
  launcher's pid. Windows needs no launcher. It is shipped in every non-Windows platform package and can be
  turned off with `launcher: false`.

## 0.1.0-rc.1

Bundled CLIProxyAPI: v8.0.43.

### Breaking

- **`server.managementKey` is removed.** Keep the key in your own code and pass it to `createClient`.
- **The deprecated `managementKey` option no longer uses `MANAGEMENT_PASSWORD`.** It maps to the default
  `management: { key }` mode (bcrypt hash in the managed config, remote management off). Combined with
  `configPath` it now throws `invalid-options`; use `management: { key, viaEnvironment: true }` or put
  `secret-key` in the file.
- **`MANAGEMENT_PASSWORD` reaches CPA only through `management: { key, viaEnvironment: true }`.** An inherited
  variable is always removed, and setting it in `env` is rejected.
- **The managed `config.yaml` is written once.** With `config`, cpajs writes `<stateDir>/config.yaml` only when it
  does not exist and reuses it afterwards, so management API changes survive restarts. `config`, `host` and `port`
  are not applied to a reused file; pass `overwriteConfig: true` to replace it.
- **The managed config is YAML** instead of JSON.
- **`configPath` requires a fixed port.** A missing, zero, negative or non-numeric port is rejected. CPA itself does
  not default to 8317 (it binds a random port), and cpajs used to assume 8317 by mistake.
- **`viaEnvironment` rejects keys with surrounding whitespace** instead of trimming them.

### Added

- `management: { key, allowRemote?, viaEnvironment? }`. The default writes a bcrypt hash into
  `management.secret-key` and keeps remote management off. A reused config is updated only when the key or
  `allow-remote` changes.
- `server.restart()`: same handle, origin and port; also clears CPA's in-memory management API ban.
- `stopAllServers()` for host signal handlers. cpajs does not install signal handlers itself.
- `overwriteConfig` option.
- Warnings through `onLog`: `viaEnvironment` (always) and `allowRemote` on a non-loopback host.

### Fixed

- A stray `MANAGEMENT_PASSWORD` in the parent environment could enable the management API when no key was
  given.
- `configPath` listener resolution now follows upstream: v8 `server.*` keys win over legacy ones whenever they
  are present, and YAML merge keys are resolved.
- Port conflicts are detected by re-probing the port after an early exit, not by matching CPA's log text.
- `oauth.waitForCompletion` no longer leaks one abort listener per poll, and always rejects with `CpaAbortError`
  when cancelled.
- Raw `Response` requests release the caller's abort listener on HTTP and network errors.
- A rejected `args` / `env` option no longer leaves a temporary state directory behind.
- CPA log lines are capped at 64 KiB with a truncation marker.

### Infrastructure

- Windows lifecycle tests and a Windows e2e job in CI.
- The release workflow requires the full CI suite on the tagged commit before publishing.
- Biome lint, coverage reporting (now including the client transport), and more real-CPA e2e tests.

## 0.0.1-alpha-3

Bundled CLIProxyAPI: v8.0.43.

- Typed options for CPA's server-mode CLI flags: `localModel`, `home: { jwt, disableClusterDiscovery }`. `args`
  is limited to plugin-registered flags; one-shot commands are rejected.
- First release published with npm provenance.

## 0.0.1-alpha-2

- First release published through npm trusted publishing (OIDC). No functional changes.

## 0.0.1-alpha-1

- First release: `@cpajs/cpa/server` (start/stop the bundled CLIProxyAPI), `@cpajs/cpa/client` (typed v8 management
  API client), and 23 platform packages.
