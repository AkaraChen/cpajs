# @cpajs/cpa

Run the official [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) from Node.js or Bun, and
manage any CPA instance with a hand-written, typed client for its native **v8 management API**.

- `@cpajs/cpa/server` locates the bundled binary, writes the config, starts the process, waits until it is ready,
  streams logs and stops it.
- `@cpajs/cpa/client` is a `fetch`-based client for `/v8/management`, with types derived from the CPA source. It can
  connect to local or remote instances.
- Prebuilt CPA binaries for 23 platforms come through `optionalDependencies`, so `npm install` is all that is
  needed.

Bundled CLIProxyAPI: **v8.0.43**.

- Upgrading: [CHANGELOG.md](CHANGELOG.md) and [docs/migration.md](docs/migration.md).
- Platforms, versions and the versioning policy: [docs/compatibility.md](docs/compatibility.md).
- Every management API route: [docs/api-coverage.md](docs/api-coverage.md).

```sh
npm install @cpajs/cpa
```

## Start a server

```ts
import { startServer } from '@cpajs/cpa/server';

const server = await startServer({
  stateDir: './.cpa',                 // omit for a temporary directory that is removed on stop
  config: {                           // native v8 config, typed as CpaConfig
    access: { 'api-keys': ['sk-my-model-key'] },
    routing: { strategy: 'fill-first' },
  },
  onLog: ({ stream, line }) => console.log(`[cpa ${stream}] ${line}`),
});

console.log(server.origin);  // http://127.0.0.1:40123  (a free port is picked by default)
console.log(server.baseUrl); // http://127.0.0.1:40123/v1 for OpenAI-compatible SDKs

// Management API client, already bound to this server and a key generated for this start.
const client = server.client();
await client.credentials.list();

await server.stop();
```

- `config` and `configPath` are mutually exclusive.
  - `config` is either a native config object or a function that returns one.
    - An object is written as YAML to `<stateDir>/config.yaml` only when that file does not exist yet. On later
      starts the existing file is reused, so changes made through the management API (or by CPA itself) survive
      `stop()` and `startServer()`. Pass `overwriteConfig: true` to replace it; when a file is kept, `config`, `host`
      and `port` are not applied and a `configReused` warning is emitted. Credentials go to `<stateDir>/auths`
      unless `oauth.auth-dir` is set. The server binds `127.0.0.1` unless you pass `host` or set `server.host`.
    - A function is called before the first start and again before every restart. It receives
      `{ existing, reason }`: the parsed current `<stateDir>/config.yaml` (or `undefined`) and `'start'` or
      `'restart'`. Its result replaces the file each time, like `overwriteConfig: true`, while cpajs still fills in
      the listener, management secret and panel fields. It cannot be combined with `overwriteConfig`, and a
      `configReused` warning is never emitted. The management key is resolved before the function runs, so
      `management['secret-key']` in its result does not choose the key behind `server.client()`; pass
      `management` for that (or keep the generated key).
  - `configPath` hands an existing file to CPA unchanged. CPA may rewrite it on startup: it hashes a plaintext
    `management.secret-key`, removes legacy keys that conflict with their v8 equivalents, and normalizes the
    layout (`internal/config/config_load.go` and `NormalizeConfigLayout`).

  Both modes require the file to set a fixed positive port: CPA does not default the port, and a missing or
  non-positive one becomes 0, which makes CPA bind a random port it does not report. Like upstream,
  `server.host` / `server.port` / `server.tls.enable` win by presence over the legacy top-level `host` / `port` /
  `tls.enable`. When cpajs writes the file and no port is given, it picks a free port first; a reused file keeps
  the port it already has.
- `startServer` resolves only once `/healthz` answers. It rejects with `CpaStartError` on early exit, port
  conflict, timeout (`startupTimeoutMs`, default 30 s), `signal` abort, or an `afterStart` hook failure. In every
  failure case the process is stopped and the temporary directory removed.
- `stop()` is idempotent: on POSIX it sends SIGTERM and then SIGKILL after `stopTimeoutMs` (default 10 s). On
  Windows Node cannot deliver a graceful shutdown signal, so `stop()` terminates the process forcefully (equivalent
  to SIGKILL), `stopTimeoutMs` has no effect, and CPA gets no chance to flush state or update auth files. The same
  applies to the stop half of `restart()`. `server.exited` settles on the final stop or an unexpected exit.
- `restart({ timeoutMs, signal })` stops the old process with the same SIGTERM → SIGKILL sequence
  (`timeoutMs` defaults to `stopTimeoutMs`) and starts it again with the original options. The handle keeps
  `origin`, `baseUrl`, `host`, `port`, `stateDir` and `configPath`; `pid`, `process` and `recentLogs` point at the
  new process. With an object `config`, the existing `config.yaml` is reused and never rewritten, so changes made
  through the management API survive. A function `config` is evaluated again before each restart and its result
  replaces the file. A dynamic port is reused too; if another process took it meanwhile, restart fails with
  `CpaStartError` code `port-in-use` instead of changing `origin`. Concurrent `restart()` calls share one
  operation, `stop()` during a restart aborts it, and `restart()` after `stop()` rejects. A failed restart leaves
  the handle stopped and cleans up a temporary state directory like `startServer` does.
- `restart: { onUnexpectedExit, backoffMs, stableAfterMs, maxAttempts }` restarts CPA by itself after an
  unexpected exit. It goes through the same path as `restart()`, so `origin`, `port`, the handle, the existing
  config file and already-created `server.client()` instances keep working. `backoffMs` defaults to
  `[500, 1000, 5000, 30_000]` and its last value repeats. A restarted process must stay up for `stableAfterMs`
  (default 60 s) to count as healthy; one that exits before it keeps the backoff position, so a crash loop
  escalates instead of restarting every 500 ms. `maxAttempts` consecutive restarts without a stable run stop the
  server and settle `exited` (default `Infinity`); a manual `restart()` resets the count. `stop()` cancels a
  pending wait, and `restart()` during one tries immediately. A port taken by another process makes that attempt
  fail and retries after the next backoff instead of changing `origin`.
- `singleton: true` reuses one server per process for the same resolved `stateDir` (or absolute `configPath`),
  so a dev server that evaluates a module more than once cannot start CPA twice. Concurrent calls share the
  in-flight start and its promise; a handle that has not stopped yet is returned as-is, including while it is
  backing off or restarting. Once the handle stops, the next call starts a new process. It requires an explicit
  `stateDir` or `configPath`, and the options of the first call win: options on later calls are not compared.
  The registry lives on `globalThis` (keyed by `Symbol.for('cpajs.servers')`), so duplicate module instances
  in the same process share it.
- Lifecycle events: `server.on('exit' | 'restart' | 'restarted' | 'restart-failed', listener)` returns an
  unsubscribe function. An `exit` payload has `code`, `signal`, `recentLogs` and `willRestart`; `restart` and
  `restarted` carry `reason` (`'unexpected-exit' | 'manual'`) and `attempt`, and `restarted` also has
  `originChanged` (currently always `false`); `restart-failed` has `error`, `attempt` and `willRetry`. A
  listener that throws is reported through `process.emitWarning` and never disturbs the server.
- `hooks.afterStart({ server, client, reason })` runs after each process is ready: the first start and every
  restart, manual or automatic. `reason` is `'start'` or `'restart'`; `client` is `server.client()` when cpajs
  knows the plaintext management key and `undefined` otherwise. If it throws, the first start rejects with
  `CpaStartError` code `hook-failed` after stopping the process, while a restart fails like any other
  (`restart-failed`, then backoff or a rejected `restart()`).
- Shutdown: CPA does not outlive your process, even if it is killed with SIGKILL, crashes, or is restarted by
  `tsx watch` / `nodemon`. Each platform package ships a small `cpa-launcher` (pure Go, in `launcher/`) that
  relies only on operating-system facilities:
  - Linux: it sets `PR_SET_PDEATHSIG` and execs CPA, so there is no extra process. The kernel sends CPA SIGTERM
    when your process dies.
  - macOS / BSD: it stays as CPA's parent and stops CPA when the pipe to your process closes. `server.pid` is
    then the launcher's pid; signals sent to it reach CPA.
  - Windows: no launcher is needed, because Node already kills child processes with their parent.

  Pass `launcher: false` to start CPA directly. With a custom `binaryPath`, the launcher is looked up next to
  that binary and then in the installed platform package; if none is found, CPA starts directly. A graceful stop
  is still nicer than a kill, and `stopAllServers()` stops every server this process started:

  ```ts
  import { stopAllServers } from '@cpajs/cpa/server';

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      await stopAllServers();
      process.exit(0);
    });
  }
  ```

  Lines longer than 64 KiB in CPA's output are truncated, with a marker saying how much was dropped.
- Logs: `onLog` receives every line with `stream` and the redacted `line`. When the line uses CPA's log format,
  it also has `level` (`debug`, `info`, `warn`, `error` or `fatal`), the short 8-character `requestId` (omitted
  for CPA's `--------` placeholder) and `message` (the text after CPA's timestamp, request-id, level and caller
  prefixes). Output that does not match the format still arrives, with only `stream` and `line`.

  Pass `logs: { minLevel: 'warn' }` to drop lower-severity lines from `onLog`; `recentLogs` keeps everything,
  because error messages often need the surrounding info lines. Lines without a parsed level pass by default, so
  unknown output is never hidden; `logs: { minLevel: 'warn', unleveled: 'stderr' }` keeps only those on stderr
  (such as a Go panic) and drops CPA's stdout banner, and `unleveled: 'none'` drops them all.

  ```ts
  await startServer({ config, logs: { minLevel: 'warn' }, onLog: ({ level, message, line }) => {
    console.log(`[${level ?? 'raw'}] ${message ?? line}`);
  } });
  ```
- Management key: you usually don't need one. Without `management`, cpajs generates a random key for each start,
  writes only its bcrypt hash into the managed config (remote management off), keeps the plaintext in memory,
  and gives you `server.client()`: a management client bound to this server. The key is never exposed, and
  because nobody types it, it can never be wrong and trigger CPA's 30-minute IP ban. `restart()` keeps the key,
  so existing clients keep working; a new `startServer()` generates a new one. Since no one could log in to the
  web control panel with that key, the panel defaults to off (`disable-control-panel: true`). `management: false`
  turns the management API off.

  Pass a key yourself when a person or something else needs it, for example the web control panel, a remote
  admin tool or another process: `management: { key }`. The default mode writes a bcrypt hash into
  `management.secret-key` of the managed config and sets `management.allow-remote` from `allowRemote` (default
  `false`), so the plaintext never reaches disk and remote management stays off. `server.client()` works there
  too.

  The three steps build on each other: no key (only this process), `management: { key }` (people on this
  machine, with the control panel), `allowRemote: true` (people elsewhere too). The rest of the table below is
  for setups that need more control.

  Control panel: `@cpajs/cpa` ships a pinned copy of the web control panel (`management.html`, see
  [compatibility](docs/compatibility.md)), checked against its sha256 when the package is built. In a config
  cpajs manages, CPA serves that copy at `/management.html` and never downloads one: cpajs copies it to
  `<stateDir>/static/`, points `MANAGEMENT_STATIC_PATH` at it and defaults `disable-auto-update-panel` to `true`.
  Upstream would otherwise fetch the latest panel from GitHub on start and every 3 hours, falling back to an
  unverified mirror. To get that behaviour back, set `disable-auto-update-panel: false` or
  `panel-github-repository` in `config.management`, or set `MANAGEMENT_STATIC_PATH` in `env`. With `configPath`,
  cpajs leaves the panel to your file.

  Redaction: the key, secrets found in the config when the server starts, and `redact` values are replaced with
  `[REDACTED]` in `onLog`, `recentLogs` and startup errors. This is best-effort, with known limits:
  - Values shorter than 4 characters are not redacted.
  - Credentials added while the server runs (management API, OAuth logins, `restart()`) are not added to
    the redaction list.
  - A line longer than 64 KiB is truncated before redaction, which can leave the start of a secret at the cut.

  Do not treat CPA's output as safe to publish.

  | Mode | How CPA compares the key | Remote access | `server.client()` | Control panel |
  | --- | --- | --- | --- | --- |
  | omitted (default) | bcrypt hash of a key generated per start | Off | Yes | Off (nobody knows the key) |
  | `management: false` | — (management API disabled) | — | No | — |
  | `management: { key }` | bcrypt hash in `management.secret-key` | Written from `allowRemote`, default `false` | Yes | Pinned copy |
  | `management: { key, allowRemote: true }` | bcrypt hash in `management.secret-key` | Non-loopback clients allowed | Yes | Pinned copy |
  | `management: { key, viaEnvironment: true }` | Plaintext `MANAGEMENT_PASSWORD` | Always allowed: upstream treats the variable as `allow-remote: true` | Yes | Pinned copy |
  | `config.management['secret-key']` | What you write; CPA hashes plaintext on startup | `config.management['allow-remote']` | No: the key is yours | Pinned copy |
  | `configPath` | `secret-key` in the file | `allow-remote` in the file | Only with `management: { key, viaEnvironment: true }` | Your file decides |
  | `managementKey` (deprecated) | bcrypt hash, same as `management: { key }` | Off unless the file allows it | Yes | Pinned copy |

  `management.key` is rejected together with `config.management['secret-key']`, or with a `secret-key`
  already present in `configPath`. In `configPath` mode it also requires `viaEnvironment: true`, because
  cpajs must not edit your file.

  `MANAGEMENT_PASSWORD` reaches CPA only through `viaEnvironment: true`. One inherited from the parent
  environment is always removed, and setting it in `env` is rejected. Otherwise it would quietly add a
  plaintext key and turn remote management on.

  `viaEnvironment: true` always emits the `managementViaEnvironment` warning, because the key is compared in
  plaintext and remote management cannot be turned off. `allowRemote: true` emits `remoteManagementExposed` when
  the bind host is not loopback. These are warnings, not errors, because both are explicit choices.

  The server handle never exposes the key; `server.client()` exposes the capability instead. To connect from
  elsewhere, pass your own key to `createClient`.
- Warnings: cpajs reports things worth knowing as coded warnings, separate from CPA's output (`onLog`). By
  default they go through `process.emitWarning` as `CpaWarning`, so they appear on stderr and work with Node's
  usual handling (`--no-warnings`, `process.on('warning')`). Pass `onWarning` to route them yourself. Pass
  `suppressWarnings` to silence individual ones; every message names the field that silences it.

  ```ts
  await startServer({ config, suppressWarnings: { noManagementKey: true } });
  ```

  | Code | Emitted when |
  | --- | --- |
  | `noManagementKey` | No `management` was given, so a key was generated for this start (use `server.client()`) |
  | `managementViaEnvironment` | `management.viaEnvironment` is used: plaintext comparison, remote management forced on |
  | `remoteManagementExposed` | `allowRemote` is on and the server binds a non-loopback host |
  | `configReused` | An existing managed config was kept; this start's `config`, `host` and `port` were not applied |
  | `managementKeyUpdated` | A reused config's management key was replaced for a new `management.key` |

- CLI flags are typed options:
  - `localModel: true` → `-local-model`, which uses the embedded model catalogs.
  - `home: { jwt, disableClusterDiscovery }` → Home mode. The JWT is passed through `HOME_JWT`, so it never appears in argv.

  `args` is only for flags that plugins register. One-shot commands (`-*-login`, `-discover`, `-tui`, …) and flags that have a typed option are rejected.
- `binaryPath` overrides the bundled binary.

## Manage a server

```ts
import { createClient, CpaHttpError } from '@cpajs/cpa/client';

const client = createClient({
  baseUrl: 'http://127.0.0.1:8317',     // a path prefix behind a reverse proxy is kept
  managementKey: process.env.CPA_MANAGEMENT_KEY!,
  timeoutMs: 15_000,
});

const { data: config, etag } = await client.config.get();
await client.config.patch({ routing: { strategy: 'round-robin' } }, { ifMatch: etag });
await client.config.set('routing/retry/request-retry', 2); // value typed by path: number

// Read → change → write with If-Match. `auth_index` (injected on reads) is removed,
// a 412 re-reads and retries, and returning undefined skips the write.
await client.config.update('routing/strategy', (current) => current ?? 'fill-first');

// Deep-compares each top-level section and replaces only the ones that differ.
// A listed section is written wholesale, so nested keys absent from it are removed;
// sections not listed are untouched.
await client.config.reconcile({ routing: { strategy: 'fill-first' } });

const { files } = await client.credentials.list();
await client.credentials.upload({ name: 'codex-me.json', content: credentialJson });

// Files and config `api-keys` entries in one list, with the runtime auth_index.
const all = await client.credentials.listAll();
const models = await client.credentials.modelsFor({ auth_index: all[0]!.auth_index }, { details: true });

const desired = [{ name: 'chat-a.json', content: credentialJson, revision: '2026-10-27' }];
const synced = await client.credentials.reconcile({
  owner: 'chat',
  files: desired,
  // A legacy file without `x-cpajs` is claimed in place. Returning its desired
  // revision keeps the tokens CPA already rotated; a different one uploads `desired`.
  adopt: (name, body) =>
    body.chat_seed === undefined ? undefined : desired.find((file) => file.name === name)?.revision,
});
console.log(synced); // { uploaded: ['chat-a.json'], deleted: [], unchanged: [], adopted: [] }

const login = await client.oauth.start({ provider: 'claude' });
console.log('open', login.url);
await client.oauth.waitForCompletion(login.state);

try {
  await client.config.getPath('does/not/exist');
} catch (error) {
  if (error instanceof CpaHttpError) console.log(error.status, error.errorCode); // 404 'not_found'
}
```

`credentials.reconcile` keeps a set of files owned by one caller in sync. Uploads carry a reserved
`x-cpajs: { owner, revision }` field. Only `revision` is compared, so CPA rewriting a file during a token
refresh does not cause another upload. With `prune` (the default), files owned by `owner` that are no longer
in `files` are deleted; files owned by anyone else are never touched. The caller's content objects are not
mutated.

A same-name file without the marker is never overwritten. Reconcile throws `CpaReconcileError` with code
`unmarked` (also for files owned by another caller, code `owned-by-other`) unless `adopt(name, body)` returns
a revision. Adoption keeps the stored content, including tokens, writes only the marker, and then compares the
returned revision with the desired one: equal leaves the file alone, different uploads the desired content.
Returning `undefined` leaves the file unmanaged; a same-name unmarked file then still throws. `adopt` is also
called for unmarked files in the prune range, so a recognized legacy file can be claimed and deleted.
`files[].content` accepts an object, JSON text, bytes, or a `Blob`; strings and bytes are parsed and must
resolve to a JSON object, which is checked before any request.

`credentials.listAll` merges credential files with the config's `api-keys` entries, which `/credentials` only
exposes as a runtime view. Select either a file by `name` or any credential by `auth_index` with
`credentials.modelsFor`. Config-key models follow CPA's own resolution (model aliases, `excluded-models` with
`*` wildcards, and per-key overrides); `details: true` adds the channel's static model definitions. Runtime
state such as cooldowns is only available for files.

| Group | Routes |
| --- | --- |
| `config` | `/config`, `/config.yaml`, `/config/*path`, with ETag / `If-Match`, plus `update` / `reconcile` |
| `credentials` | list all (files + config keys), models per credential (with details), upload (raw or multipart), reconcile by owner/revision (with adoption), delete, download, status, fields, refresh, SIWC status |
| `oauth` | auth URL, status / wait, cancel, callback, Vertex import, SIWC bind |
| `logs` | main log with cursor, clear, error logs, request logs |
| `usage` | API-key counters, usage queue (destructive pop) |
| `routing` | cooldown reset, model definitions |
| `requests` | server-side `api-call` (`apiCall`, `apiCallJson`) |
| `plugins` | list, delete, store, install, quota |
| `server` | `/healthz`, version headers, latest release |

`requests.apiCallJson()` is the throwing variant of `apiCall` for JSON upstreams: the parsed body becomes `data`,
a non-2xx upstream status throws `CpaUpstreamError`, a 2xx body that is not JSON throws `CpaResponseError`, and
an unresolvable `$TOKEN$` throws `CpaCredentialTokenError`.

Every method takes `{ signal, timeoutMs, headers }`. GET requests retry CPA's transient
`500 invalid_config` (a read landing while `config.yaml` is rewritten) up to three times after
100/200/400 ms; writes never retry. Pass `retryInvalidConfig: false` to `createClient` to disable it. Errors:

- `CpaHttpError` for a non-2xx response. It carries `status`, the raw `body`, parsed `data`, and `errorCode` /
  `errorMessage`.
- `CpaUpstreamError` when `requests.apiCallJson` gets a non-2xx upstream status. It carries the upstream
  `status`, `headers`, and `body` (parsed when JSON).
- `CpaCredentialTokenError` when `requests.apiCallJson` cannot resolve `$TOKEN$`. It carries `status` and
  `errorCode`.
- `CpaReconcileError` when `credentials.reconcile` will not overwrite a file. It carries `code` (`unmarked` or
  `owned-by-other`) and `file`.
- `CpaNetworkError` when the request fails.
- `CpaTimeoutError` when the request times out.
- `CpaAbortError` when your `signal` aborts the request.
- `CpaResponseError` when a 2xx response has a malformed body.

A 207 partial result resolves normally. Use `client.request()` for anything without a typed method.

### Management-key bans

The fifth consecutive wrong management key from one IP address bans that IP for 30 minutes. While banned, CPA
answers 403 `{"error":"IP banned due to too many failed attempts. Try again in <duration>"}` before it even checks
the supplied key. Loopback clients are included, and `127.0.0.1` and `::1` are separate counters. The failed-attempt
map is in process memory and upstream has no unban route.

For a server you started with `startServer`, call `server.restart()` to clear the ban. For a remote instance you
can only wait for it to expire. Do not retry a 401 `invalid management key` or `missing management key` in a loop.

### Model API

The management key and model API keys are different things. Model requests go to `server.baseUrl` or
`client.modelBaseUrl` with a key from `access.api-keys`:

```ts
import OpenAI from 'openai';
const openai = new OpenAI({ baseURL: server.baseUrl, apiKey: 'sk-my-model-key' });
```

## Bundling and deploying

The platform package is an optional dependency picked at runtime, so a bundler cannot see it in a normal
`import`. `@cpajs/cpa/binary` is a small entry that contains a literal `require.resolve()` for every target;
importing it for its side effect puts the installed platform packages in the module graph:

```ts
import '@cpajs/cpa/binary';
```

Trace on the deployment platform (including glibc vs musl). A file tracer such as `@vercel/nft` then copies
the package that matches the build machine. Keep `@cpajs/cpa` and `@cpajs/<target>` external rather than
bundling them. nft reports a warning for every platform package that is not installed; those are expected
and non-fatal.

Nitro uses nft. Import the entry from the server code, and full-trace the platform package so its `bin/`
directory is copied too (`pkg*` copies every file, not only the traced ones):

```ts
import { resolveBinary } from '@cpajs/cpa/server';

export default defineNitroConfig({
  // The platform package installed on the build machine, e.g. @cpajs/linux-x64-gnu.
  // Build on the platform you deploy to, or write the package name out instead.
  traceDeps: ['@cpajs/cpa', `${resolveBinary().packageName}*`],
});
```

Vite SSR leaves packages in `node_modules` external; make that explicit and run nft over the server output (or
over `@cpajs/cpa/binary`) as part of the deploy step:

```ts
export default defineConfig({
  ssr: { external: ['@cpajs/cpa'] },
});
```

Next.js: keep cpajs outside the server bundle and let output file tracing include it:

```js
module.exports = {
  serverExternalPackages: ['@cpajs/cpa'],
};
```

In all three setups the side-effect import is what makes the table visible; if a trace still misses the
binary, copy `node_modules/@cpajs/<target>/` into the deployment or pass `binaryPath` to `startServer`.

Bun ignores `libc`, so `bun install` on Linux installs both `@cpajs/linux-*-gnu` and `@cpajs/linux-*-musl`
(about 72 MB extra). Install with npm or pnpm, or delete the packages for the other libc before packaging;
cpajs still picks the right target at runtime. `binaryPath` also lets you ship a single binary yourself.

## Development

```sh
pnpm install
pnpm lint                                          # Biome
pnpm typecheck && pnpm test                       # unit tests (mocked fetch + a fake CPA process)
pnpm test:coverage                                 # line coverage for client resources and src/server
node scripts/build-binary.ts --target linux-x64-musl
CPA_BINARY=dist-bin/linux-x64-musl/cli-proxy-api pnpm test:e2e   # contract tests against real CPA
```

Biome formatting is configured to match the existing style. The current tree predates it, so enforcing
formatting across the whole repository is left to a dedicated change; `pnpm format:check` currently covers
new examples only.

Release tooling, all in `scripts/` and run directly with Node's type stripping:

| Script | Purpose |
| --- | --- |
| `fetch-source.ts` | Clone the pinned CPA tag and verify the commit. |
| `generate-binary-table.ts` | Regenerate `src/binary-packages.cjs` and its types from `TARGETS`; `--check` fails on drift. |
| `build-binary.ts` | Build one or more targets, with the same CGO/plugin split as upstream. |
| `verify-binary.ts` | Check format, CPU, static linking and the glibc baseline; `--smoke` starts the binary. |
| `assemble-packages.ts` | Create the `@cpajs/*` platform packages. |
| `pack.ts` | Produce the tarballs. |
| `install-test.ts` | Install the tarballs through a local registry with npm, pnpm or bun, and run them. |
| `trust-publishers.ts` | Configure npm trusted publishing for all packages (run locally after the first publish). |

`.github/workflows/release.yml` runs these steps across the whole platform matrix and publishes on `v*` tags through npm trusted publishing (OIDC). Prerelease versions such as `0.0.1-alpha-1` go to a matching dist-tag (`alpha`). There is no npm token; `trust-publishers.ts` configures the trusted publisher for every package. A newly added platform package has to exist on npm before it can be trusted.

## License

MIT. The bundled CLIProxyAPI binaries are MIT licensed by their authors; each platform package ships their LICENSE.
