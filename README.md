# @cpajs/cpa

Run the official [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) from Node.js or Bun, and
manage any CPA instance with a hand-written, typed client for its native **v8 management API**.

- `@cpajs/cpa/server` locates the bundled binary, writes the config, starts the process, waits until it is ready,
  streams logs and stops it.
- `@cpajs/cpa/client` is a `fetch`-based client for `/v8/management`, with types derived from the CPA source. It can
  connect to local or remote instances.
- Prebuilt CPA binaries for 23 platforms come through `optionalDependencies`, so `npm install` is all that is
  needed.

Bundled CLIProxyAPI: **v8.0.43**. See [docs/compatibility.md](docs/compatibility.md) for platforms and versions,
and [docs/api-coverage.md](docs/api-coverage.md) for every route.

```sh
npm install @cpajs/cpa
```

## Start a server

```ts
import { startServer } from '@cpajs/cpa/server';

const server = await startServer({
  stateDir: './.cpa',                 // omit for a temporary directory that is removed on stop
  management: { key: process.env.CPA_MANAGEMENT_KEY! },
  config: {                           // native v8 config, typed as CpaConfig
    access: { 'api-keys': ['sk-my-model-key'] },
    routing: { strategy: 'fill-first' },
  },
  onLog: ({ stream, line }) => console.log(`[cpa ${stream}] ${line}`),
});

console.log(server.origin);  // http://127.0.0.1:40123  (a free port is picked by default)
console.log(server.baseUrl); // http://127.0.0.1:40123/v1 for OpenAI-compatible SDKs

await server.stop();
```

- `config` and `configPath` are mutually exclusive.
  - `config` is written as YAML to `<stateDir>/config.yaml` only when that file does not exist yet. On later
    starts the existing file is reused, so changes made through the management API (or by CPA itself) survive
    `stop()` and `startServer()`. Pass `overwriteConfig: true` to replace it; when a file is kept, `config`, `host`
    and `port` are not applied and a message is emitted through `onLog`. Credentials go to `<stateDir>/auths`
    unless `oauth.auth-dir` is set. The server binds `127.0.0.1` unless you pass `host` or set `server.host`.
  - `configPath` hands an existing file to CPA unchanged. CPA may rewrite it on startup: it hashes a plaintext
    `management.secret-key`, removes legacy keys that conflict with their v8 equivalents, and normalizes the
    layout (`internal/config/config_load.go` and `NormalizeConfigLayout`).

  Both modes require the file to set a fixed positive port: CPA does not default the port, and a missing or
  non-positive one becomes 0, which makes CPA bind a random port it does not report. Like upstream,
  `server.host` / `server.port` / `server.tls.enable` win by presence over the legacy top-level `host` / `port` /
  `tls.enable`. When cpajs writes the file and no port is given, it picks a free port first; a reused file keeps
  the port it already has.
- `startServer` resolves only once `/healthz` answers. It rejects with `CpaStartError` on early exit, port
  conflict, timeout (`startupTimeoutMs`, default 30 s) or `signal` abort. In every failure case the process is
  stopped and the temporary directory removed.
- `stop()` is idempotent: on POSIX it sends SIGTERM and then SIGKILL after `stopTimeoutMs` (default 10 s). On
  Windows Node cannot deliver a graceful shutdown signal, so `stop()` terminates the process forcefully (equivalent
  to SIGKILL), `stopTimeoutMs` has no effect, and CPA gets no chance to flush state or update auth files. The same
  applies to the stop half of `restart()`. `server.exited` settles on the final stop or an unexpected exit.
- `restart({ timeoutMs, signal })` stops the old process with the same SIGTERM → SIGKILL sequence
  (`timeoutMs` defaults to `stopTimeoutMs`) and starts it again with the original options. The handle keeps
  `origin`, `baseUrl`, `host`, `port`, `stateDir` and `configPath`; `pid`, `process` and `recentLogs` point at the
  new process. The existing `config.yaml` is reused and never rewritten, so changes made through the management
  API survive. A dynamic port is reused too; if another process took it meanwhile, restart fails with
  `CpaStartError` code `port-in-use` instead of changing `origin`. Concurrent `restart()` calls share one
  operation, `stop()` during a restart aborts it, and `restart()` after `stop()` rejects. A failed restart leaves
  the handle stopped and cleans up a temporary state directory like `startServer` does.
- Shutdown: CPA processes are killed when the host exits normally or calls `process.exit()`. A signal the host
  does not handle (for example a default SIGTERM) ends Node without that cleanup, and cpajs does not install
  signal handlers, because doing so would change how your process reacts to them. To leave nothing behind,
  stop servers from your own handlers. `stopAllServers()` stops every server this process started:

  ```ts
  import { stopAllServers } from '@cpajs/cpa/server';

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      await stopAllServers();
      process.exit(0);
    });
  }
  ```

  SIGKILL cannot be handled, so nothing can clean up after it. Lines longer than 64 KiB in CPA's output are
  truncated, with a marker saying how much was dropped.
- `management: { key }` manages the management API key. The default mode writes a bcrypt hash into
  `management.secret-key` of the managed config and sets `management.allow-remote` from `allowRemote`
  (default `false`), so the plaintext never reaches disk and remote management stays off. The key, config
  secrets and `redact` values are masked in logs and errors.

  | Mode | How CPA compares the key | Remote access |
  | --- | --- | --- |
  | `management: { key }` (default) | bcrypt hash in `management.secret-key` | Written from `allowRemote`, default `false` |
  | `management: { key, allowRemote: true }` | bcrypt hash in `management.secret-key` | Non-loopback clients allowed |
  | `management: { key, viaEnvironment: true }` | Plaintext `MANAGEMENT_PASSWORD` | Always allowed: upstream treats the variable as `allow-remote: true` |
  | `config.management['secret-key']` | What you write; CPA hashes plaintext on startup | `config.management['allow-remote']` |
  | `configPath` | `secret-key` in the file | `allow-remote` in the file |
  | `managementKey` (deprecated) | bcrypt hash, same as the default | Same as the default; it no longer opens remote access |

  `management.key` is rejected together with `config.management['secret-key']`, or with a `secret-key`
  already present in `configPath`. In `configPath` mode it also requires `viaEnvironment: true`, because
  cpajs must not edit your file.

  `MANAGEMENT_PASSWORD` reaches CPA only through `viaEnvironment: true`. One inherited from the parent
  environment is always removed, and setting it in `env` is rejected. Otherwise it would quietly add a
  plaintext key and turn remote management on.

  `viaEnvironment: true` always emits a warning through `onLog`, because the key is compared in plaintext and
  remote management cannot be turned off. `allowRemote: true` emits one when the bind host is not loopback.
  These are warnings, not errors, because both are explicit choices.

  The server handle does not expose the key. Keep it in your own code and pass it to `createClient`.
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
await client.config.set('routing/retry/request-retry', 2);

const { files } = await client.credentials.list();
await client.credentials.upload({ name: 'codex-me.json', content: credentialJson });

const login = await client.oauth.start({ provider: 'claude' });
console.log('open', login.url);
await client.oauth.waitForCompletion(login.state);

try {
  await client.config.getPath('does/not/exist');
} catch (error) {
  if (error instanceof CpaHttpError) console.log(error.status, error.errorCode); // 404 'not_found'
}
```

| Group | Routes |
| --- | --- |
| `config` | `/config`, `/config.yaml`, `/config/*path`, with ETag / `If-Match` |
| `credentials` | list, upload (raw or multipart), delete, models, download, status, fields, refresh, SIWC status |
| `oauth` | auth URL, status / wait, cancel, callback, Vertex import, SIWC bind |
| `logs` | main log with cursor, clear, error logs, request logs |
| `usage` | API-key counters, usage queue (destructive pop) |
| `routing` | cooldown reset, model definitions |
| `requests` | server-side `api-call` |
| `plugins` | list, delete, store, install, quota |
| `server` | `/healthz`, version headers, latest release |

Every method takes `{ signal, timeoutMs, headers }`. Errors:

- `CpaHttpError` for a non-2xx response. It carries `status`, the raw `body`, parsed `data`, and `errorCode` /
  `errorMessage`.
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
| `build-binary.ts` | Build one or more targets, with the same CGO/plugin split as upstream. |
| `verify-binary.ts` | Check format, CPU, static linking and the glibc baseline; `--smoke` starts the binary. |
| `assemble-packages.ts` | Create the `@cpajs/*` platform packages. |
| `pack.ts` | Produce the tarballs. |
| `install-test.ts` | Install the tarballs through a local registry with npm, pnpm or bun, and run them. |
| `trust-publishers.ts` | Configure npm trusted publishing for all packages (run locally after the first publish). |

`.github/workflows/release.yml` runs these steps across the whole platform matrix and publishes on `v*` tags through npm trusted publishing (OIDC). Prerelease versions such as `0.0.1-alpha-1` go to a matching dist-tag (`alpha`). There is no npm token; `trust-publishers.ts` configures the trusted publisher for every package. A newly added platform package has to exist on npm before it can be trusted.

## License

MIT. The bundled CLIProxyAPI binaries are MIT licensed by their authors; each platform package ships their LICENSE.
