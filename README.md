# cpa-js

Run the official [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) from Node.js or Bun, and
manage any CPA instance with a hand-written, typed client for its native **v8 management API**.

- `cpa-js/server` locates the bundled binary, writes the config, starts the process, waits until it is ready,
  streams logs and stops it.
- `cpa-js/client` is a `fetch`-based client for `/v8/management`, with types derived from the CPA source. It can
  connect to local or remote instances.
- Prebuilt CPA binaries for 23 platforms come through `optionalDependencies`, so `npm install` is all that is
  needed.

Bundled CLIProxyAPI: **v8.0.43**. See [docs/compatibility.md](docs/compatibility.md) for platforms and versions,
and [docs/api-coverage.md](docs/api-coverage.md) for every route.

```sh
npm install cpa-js
```

## Start a server

```ts
import { startServer } from 'cpa-js/server';

const server = await startServer({
  stateDir: './.cpa',                 // omit for a temporary directory that is removed on stop
  managementKey: process.env.CPA_MANAGEMENT_KEY,
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
  - `config` is written to `<stateDir>/config.yaml` on every start. Credentials go to `<stateDir>/auths` unless
    `oauth.auth-dir` is set. The server binds `127.0.0.1` unless you pass `host` or set `server.host`.
  - `configPath` hands an existing file to CPA unchanged. CPA may rewrite it, for example to hash
    `management.secret-key`. The file must set a fixed port, because CPA does not report the port it picks.
- `startServer` resolves only once `/healthz` answers. It rejects with `CpaStartError` on early exit, port
  conflict, timeout (`startupTimeoutMs`, default 30 s) or `signal` abort. In every failure case the process is
  stopped and the temporary directory removed.
- `stop()` is idempotent: it sends SIGTERM and then SIGKILL after `stopTimeoutMs` (default 10 s). On Windows Node
  can only terminate forcefully. `server.exited` settles however the process ends.
- `managementKey` is passed through `MANAGEMENT_PASSWORD`, so it never touches disk. Upstream treats that
  variable as also allowing remote management. The key, config secrets and `redact` values are masked in logs and
  errors.
- `binaryPath` overrides the bundled binary. `args` adds CLI flags, for example `['-local-model']`.

## Manage a server

```ts
import { createClient, CpaHttpError } from 'cpa-js/client';

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
pnpm typecheck && pnpm test                       # unit tests (mocked fetch + a fake CPA process)
node scripts/build-binary.ts --target linux-x64-musl
CPA_BINARY=dist-bin/linux-x64-musl/cli-proxy-api pnpm test:e2e   # contract tests against real CPA
```

Release tooling, all in `scripts/` and run directly with Node's type stripping:

| Script | Purpose |
| --- | --- |
| `fetch-source.ts` | Clone the pinned CPA tag and verify the commit. |
| `build-binary.ts` | Build one or more targets, with the same CGO/plugin split as upstream. |
| `verify-binary.ts` | Check format, CPU, static linking and the glibc baseline; `--smoke` starts the binary. |
| `assemble-packages.ts` | Create the `@cpa-js/*` platform packages. |
| `pack.ts` | Produce the tarballs. |
| `install-test.ts` | Install the tarballs through a local registry with npm, pnpm or bun, and run them. |

`.github/workflows/release.yml` runs these steps across the whole platform matrix and publishes on `v*` tags.

## License

MIT. The bundled CLIProxyAPI binaries are MIT licensed by their authors; each platform package ships their LICENSE.
