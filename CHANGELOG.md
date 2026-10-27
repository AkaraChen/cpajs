# Changelog

All notable changes to `@cpajs/cpa`. The bundled CLIProxyAPI version is listed per release; platform packages
(`@cpajs/<target>`) always share the main package version. Upgrading from an alpha? See
[docs/migration.md](docs/migration.md).

## Unreleased

### Breaking

- `credentials.reconcile` no longer overwrites an existing same-name file that has no `x-cpajs` marker.
  It throws `CpaReconcileError` with code `unmarked` (files owned by another caller now use the same class with
  code `owned-by-other`), so a legacy `chat-openai-*.json` that CPA has already refreshed is not replaced with a
  seed token. Pass the new `adopt(name, body)` callback to claim such files in place: return a revision to keep
  the stored content (tokens included) and write only the marker, or `undefined` to leave the file unmanaged.
  The adopted revision then follows the normal comparison — equal leaves the file alone, different uploads the
  desired content. `adopt` is also called for unmarked files in the prune range, so a recognized legacy file can
  be claimed and deleted. Migration from a helper that stamped legacy fields itself:
  ```ts
  const revisions = new Map(files.map((file) => [file.name, file.revision]));
  await client.credentials.reconcile({
    owner: 'chat',
    files,
    // Returning the desired revision keeps the token CPA already rotated;
    // returning a different revision uploads the desired content instead.
    adopt: (name, body) => (name.startsWith('chat-openai-') && body.chat_seed !== undefined ? revisions.get(name) : undefined),
  });
  ```

### Added

- `credentials.reconcile` returns `adopted: string[]` alongside `uploaded`, `deleted` and `unchanged`. `adopted`
  lists files claimed through `adopt`, which may also appear in one of the other lists.
- `files[].content` in `credentials.reconcile` accepts `CredentialContent` — a parsed object, JSON text, a
  `Blob`, or raw bytes — like `credentials.upload`.
- `config.set`, `config.patchPath` and `config.update` now type tuple paths by the value at that path, the
  same as their slash-separated form. `['routing', 'strategy']` takes a routing strategy and rejects other
  JSON values, where it used to accept any `JsonInput`. Type a path as `readonly string[]` to keep the untyped
  behaviour.

### Added

- `config.set`, `config.patchPath` and `config.update` resolve known tuple paths (`['api-keys', 'gemini']`)
  and union paths (`` `api-keys/${'gemini' | 'claude'}` `` or `['api-keys', provider]`) to the value type;
  a union path takes the union of its branches' value types. Inline array literals infer as tuples, so
  `['api-keys', 'gemini']` needs no `as const`. Broad `string` and `string[]` paths still accept any
  JSON-serialisable value. Runtime behaviour is unchanged.
- `CpaApiKeyProvider`, the set of keys under `api-keys`, for building `['api-keys', provider]` paths from a
  variable.
- `logs.unleveled: 'all' | 'stderr' | 'none'` chooses which lines without a parseable level still reach `onLog`
  when `minLevel` is set. Default `'all'` (unchanged); `'stderr'` keeps Go panics but drops CPA's stdout banner.
- README: the Nitro example derives the platform package from `resolveBinary().packageName` instead of a
  hard-coded target.

### Changed

- `requests.apiCallJson` throws `CpaResponseError` (with the upstream `status` and raw `body`) when a 2xx body
  is not JSON, instead of returning the text as `data`. A JSON endpoint answering with text is a failure, and a
  string result was easy to mistake for an empty response. Use `apiCall` for text upstreams.

### Fixed

- `credentials.reconcile` no longer expands JSON string or byte content into `{"0":"{","1":"\n",…}`, which
  produced a file CPA could not read and made the account disappear from its model list. Non-object content is
  parsed and rejected with a `TypeError` before any request is sent.

## 0.1.0-rc.5

### Added

- `singleton: true` reuses one server per process for the same resolved `stateDir` (or absolute `configPath`),
  so module reloads and concurrent callers cannot start CPA twice. Concurrent starts share one promise, a handle
  that has not stopped is returned as-is (including during auto-restart backoff/restart), and a stopped or
  failed start is removed so the next call starts a new process. Requires an explicit `stateDir` or
  `configPath`; the first call's options win. The registry is stored on `globalThis` under
  `Symbol.for('cpajs.servers')`, so duplicate module instances share it.
- `credentials.listAll(options?)` returns credential files and config `api-keys` entries together, each with
  its `auth_index`, `provider`, `source: 'file' | 'config'`, file `name` or config group `label`, `disabled`
  and the raw entry. Config keys come from `GET /config` because `/credentials` only exposes a runtime view of
  them; config-key cooldown state is not included.
- `credentials.modelsFor(selector, { details? })` lists the models one file or config key can serve. Config
  keys follow upstream resolution: a key's `models` replaces the channel defaults, `alias` becomes the
  client-facing ID, a key's `excluded-models` overrides its group's and supports `*` wildcards, and
  `display-name` / `max-context-length` / `thinking` override the defaults. With `details: true` the channel's
  `GET /routing/model-definitions/:channel` is merged into each model, requesting each channel once per call.
- Auto-restart: `restart: { onUnexpectedExit, backoffMs, stableAfterMs, maxAttempts }` starts CPA again after
  an unexpected exit through the same path as `restart()`, so `origin`, `port`, the handle, the config file and
  existing `server.client()` instances stay valid. Backoff defaults to `[500, 1000, 5000, 30_000]` and the last
  value repeats. A restarted process must stay up for `stableAfterMs` (default 60 s) to be healthy; a process
  that becomes ready and then dies keeps the backoff growing instead of restarting every 500 ms. After
  `maxAttempts` consecutive restarts without a stable run the handle stops and `exited` settles (default
  `Infinity`). `stop()` cancels a pending wait, `restart()` during one tries immediately, and a manual
  `restart()` resets the count.
- Lifecycle events on the server handle: `on('exit' | 'restart' | 'restarted' | 'restart-failed', listener)`,
  each returning an unsubscribe function. `exit` reports `code`, `signal`, `recentLogs` and `willRestart`;
  restart events carry `reason` and `attempt`, and `restarted` also has `originChanged` (currently always
  `false`). Listener errors are reported through `process.emitWarning`.
- `config` accepts a function as well as an object. It is called before the first start and before every restart
  with `{ existing, reason: 'start' | 'restart' }`, where `existing` is the parsed current
  `<stateDir>/config.yaml` (or `undefined`), and its result replaces the file while cpajs still fills in the
  listener, management secret and panel fields. It cannot be combined with `overwriteConfig` and never emits the
  `configReused` warning; the object form keeps its previous behaviour. The management key is resolved before the
  function runs, so a `management['secret-key']` it returns does not choose the key behind `server.client()`.
- `hooks.afterStart({ server, client, reason })` runs after each process is ready, on the first start and on
  every restart (manual or automatic). `client` is `server.client()` when cpajs knows the plaintext management
  key, else `undefined`. A throw fails `startServer` with `CpaStartError` code `hook-failed` after stopping the
  process, or counts as a failed restart (`restart-failed`, then backoff or rejection).
- `@cpajs/cpa/binary`: a static entry that lets bundlers trace the platform packages. Every target gets a literal
  `require.resolve('@cpajs/<target>/package.json')` in a try/catch, generated from `TARGETS` by
  `scripts/generate-binary-table.ts` and checked for drift by a unit test. The table is CommonJS so nft follows
  it under its default settings. `resolveBinary` and `resolveLauncher` reuse the same table, without changing
  how a target is chosen at runtime.
- README: a "Bundling and deploying" section with Nitro (`traceDeps`), Vite SSR (`ssr.external`) and Next.js
  (`serverExternalPackages`) examples, plus how to drop the extra gnu/musl package that Bun installs.
- `config.update(path, fn, options?)` reads one node, removes the read-only `auth_index` fields that GET
  injects, passes the value to `fn`, and writes the result back with `If-Match`. A 412 re-reads and calls `fn`
  again (5 attempts by default, `maxAttempts` to change it); returning `undefined` skips the write. Calls for
  the same path on one client instance run one at a time. A missing node passes `undefined` and is created.
- `config.reconcile(partial, options?)` deep-compares each top-level section against the stored config,
  ignoring `auth_index`, and replaces only the sections that differ. Each changed section is written
  wholesale with PUT `/config/<key>` (so nested keys absent from the target are removed) and ETags are
  chained across writes; a 412 re-reads and recomputes. Sections not listed are untouched, and a target
  value of `undefined` is skipped.
- GET requests retry CPA's transient `500 invalid_config` (a read landing while `config.yaml` is rewritten
  non-atomically) up to three times after 100/200/400 ms. Writes never retry. Disable with
  `retryInvalidConfig: false` on `createClient`.
- `credentials.reconcile({ owner, files, prune? })` aligns a managed set of credential files by owner and
  revision. Uploads carry a reserved `x-cpajs: { owner, revision }` field; only the revision is compared, so a
  CPA token refresh that rewrites a file does not upload it again. By default files owned by `owner` but no
  longer listed are deleted, while files owned by anyone else are never touched.
- Structured log lines: `LogLine` now carries `level`, `requestId` and `message` when CPA's logrus format could
  be parsed, while `line` and `stream` stay unchanged. Pass `logs: { minLevel: 'warn' }` to drop lower-severity
  lines from `onLog` instead of re-parsing text; `recentLogs` still keeps every line, and lines without a parsed
  level always pass. No new runtime dependencies.
- `requests.apiCallJson(request, options)` wraps `apiCall` for JSON upstreams: a JSON string body is parsed,
  a non-2xx upstream status throws `CpaUpstreamError` (upstream `status`, `headers`, parsed `body`), and a CPA
  400 caused by an unresolvable `$TOKEN$` throws `CpaCredentialTokenError` with CPA's `errorCode`
  (`auth token not found`, `auth credential not found for auth_index`, or `auth token refresh failed`).
  `apiCall` is unchanged and still returns the raw result.

### Changed

- A generated management key is hashed at bcrypt cost 4 (upstream's `bcrypt.MinCost`) instead of 10. CPA
  checks the key against the hash on every management request at the stored cost, so cost 10 spent about
  65 ms of CPU per request, which adds up for hosts that poll the management API. The key is 256 random
  bits, so the cheaper hash does not make it easier to guess. An explicit `management.key` keeps cost 10.

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
