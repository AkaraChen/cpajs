# Migrating from 0.1.0-rc.6

This release narrows cpajs to running CPA and a faithful typed client. See [scope.md](scope.md) for the rule.
Most removed helpers can be rebuilt from the primitives below.

## Server

### Automatic restart

`restart.onUnexpectedExit`, `onStartFailure`, `backoffMs`, `stableAfterMs`, `maxAttempts` and `allowNewPort`
are gone, along with automatic restarts, first-start retries and port switching. `restart()` is manual and
rejects once the old process has exited or been stopped.

`exited` settles for both `stop()` and an unexpected exit, so track which one you asked for and decide whether
to start a replacement:

```ts
let stopping = false;
const server = await startServer(options);
server.on('exit', (event) => {
  if (event.reason === 'unexpected' && !stopping) {
    // Start a new server yourself and point clients at its origin.
  }
});
await server.exited;
```

If the same server object is still running and you only want to recycle the process, call `server.restart()`.

### Events

Only `server.on('exit', listener)` remains; `restart`, `restarted` and `restart-failed` are removed, and so is
the `on` start option. Subscribe right after `startServer()` resolves. `exit.reason` is still `'stop'`,
`'restart'` or `'unexpected'`, and `willRestart` is true only for the stop half of a manual `restart()`.

### `afterStart` and `singleton`

There is no `afterStart` hook, cleanup return value or `requireClient()`. Run your code after `startServer()`
resolves. `server.client()` is available when cpajs knows the plaintext key, as before. For cleanup, call your
own function before `server.stop()`.

`singleton: true` is removed. Keep one promise per key yourself:

```ts
const servers = new Map<string, Promise<CpaServer>>();
function sharedStart(key: string, options: StartServerOptions): Promise<CpaServer> {
  let pending = servers.get(key);
  if (pending === undefined) {
    pending = startServer(options).finally(() => servers.delete(key));
    servers.set(key, pending);
  }
  return pending;
}
```

### Log filtering

`logs: { minLevel, unleveled }` is removed. `onLog` still receives every redacted line with parsed `level`,
`requestId` and `message`; filter in your callback:

```ts
await startServer({
  onLog: (log) => {
    if (log.level !== undefined && ['warn', 'error', 'fatal'].includes(log.level)) console.warn(log.message);
  },
});
```

## Client

### `config.update` / `config.reconcile`

Both methods are removed. Read a node, change it, and write it back with the ETag. A 412 means someone else
wrote the file; re-read and try again:

```ts
for (let attempt = 0; attempt < 5; attempt++) {
  const { data, etag } = await client.config.getPath<string>('routing/strategy');
  try {
    await client.config.set('routing/strategy', data ?? 'fill-first', { ifMatch: etag });
    break;
  } catch (error) {
    if (!(error instanceof CpaHttpError) || error.status !== 412) throw error;
  }
}
```

Use `config.patchPath` instead of `set` when the value should deep-merge. To replace a section wholesale, write
that section with `set`. There is no per-path serialisation lock any more; serialise concurrent writers yourself.

The automatic retry of `500 invalid_config` is also gone. Wrap reads that can land while CPA rewrites the file:

```ts
async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const transient = error instanceof CpaHttpError && error.status === 500 && error.errorCode === 'invalid_config';
      if (!transient || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}
```

### Function `baseUrl`

`createClient({ baseUrl })` no longer accepts a function. Pass a `string | URL`. A manual `restart()` keeps the
same origin. If you start a new server, create a new client with its new `origin`.

### Credential helpers

`credentials.reconcile`, the `x-cpajs` marker, `adopt` / `remove` and `CpaReconcileError` are removed. Sync files
with `list`, `download`, `upload` and `delete`, using your own revision field if you need one to avoid
re-uploading after CPA rotates tokens.

`credentials.listAll` and the summary types are removed. `credentials.list()` returns CPA's file entries; read
config `api-keys` through `client.config.getPath('api-keys')`. `credentials.modelsFor` and its cache are
removed: use `credentials.models(name)` for a file, or compose the channel's
`GET /routing/model-definitions/:channel` through `client.routing.modelDefinitions(channel)` with the config
entries you read.

`credentials.setStatus` and `credentials.delete` only accept file names/arrays now; `auth_index` targeting for
config keys and `CpaCredentialNotFoundError` are removed. Edit config keys through the config resource, for
example appending `*` to the key's `excluded-models` to disable it.

### `requests.apiCallJson`

`apiCallJson`, `CpaUpstreamError` and `CpaCredentialTokenError` are removed. `apiCall` already resolves on any
upstream status, so check `status_code` and parse `body` yourself:

```ts
const response = await client.requests.apiCall({ method: 'GET', url });
if (response.status_code < 200 || response.status_code >= 300) throw new Error(`upstream ${response.status_code}`);
const data = response.body === '' ? undefined : JSON.parse(response.body);
```

# Migrating from 0.1.0-rc.5

## `credentials.reconcile` no longer overwrites unmarked files

A file with the same name as one of `files` but no `x-cpajs` marker (for example one uploaded before you
adopted `reconcile`) now makes `reconcile` throw `CpaReconcileError` with code `unmarked` instead of being
replaced. Replacing it could swap a token CPA had already refreshed for a stale one. Claim such files with
`adopt`, which keeps their stored content and only adds the marker:

```ts
await client.credentials.reconcile({
  owner: 'my-app',
  files,
  adopt: (name, body) => (isMine(name, body) ? currentRevisionFor(name) : undefined),
});
```

Files owned by another caller now throw the same class with code `owned-by-other` (previously a plain `Error`).

## `requests.apiCallJson` rejects text bodies

A 2xx upstream body that is not JSON throws `CpaResponseError` (`status`, raw `body`) instead of resolving with
the text as `data`. Use `requests.apiCall` for upstreams that answer with text.

## `CredentialSummary` is a discriminated union

Narrow on `source` before reading source-specific fields: `'file'` entries have `name` and `raw: AuthFileEntry`,
`'config'` entries have `label`, `group` and the provider key as `raw`. Remove casts of `raw`.

## Tuple config paths are typed

`config.set` / `patchPath` / `update` with a known tuple path such as `['api-keys', 'gemini']` now require the
value type at that path. Fix the value, or type the path as `readonly string[]` to opt out.

# Migrating from 0.0.1-alpha-3

Every item below is a breaking change in the next release. Most code needs only the first two.

## Management key

```ts
// Before
const server = await startServer({ managementKey: key, config });
const client = createClient({ baseUrl: server.origin, managementKey: server.managementKey! });

// After
const server = await startServer({ management: { key }, config });
const client = createClient({ baseUrl: server.origin, managementKey: key });
```

- `server.managementKey` no longer exists. Keep the key yourself.
- `managementKey` still works as a deprecated alias for `management: { key }`. It no longer goes through
  `MANAGEMENT_PASSWORD`: cpajs writes a bcrypt hash into the managed config instead, and remote management stays
  off unless you pass `allowRemote: true`.
- With `configPath`, a key can only be passed through the environment, because cpajs does not edit your file:
  `management: { key, viaEnvironment: true }` (which upstream treats as enabling remote access; cpajs warns about
  it). Alternatively, put `management.secret-key` in the file yourself.
- If you relied on `MANAGEMENT_PASSWORD` being inherited from your own environment, that no longer happens. Pass
  the key explicitly.

## Managed config file

- `config` is now written to `<stateDir>/config.yaml` **once**. Later starts with the same `stateDir` reuse that
  file, so changes made through the management API survive. A changed `config` object, `host` or `port` is
  **not** applied to a reused file. Use `overwriteConfig: true` when the object should win.
- Without `stateDir`, a fresh temporary directory is used every time, so nothing changes for you.
- The file is YAML now. If you parsed it as JSON, parse it as YAML instead.

## `configPath`

The file must set a fixed port between 1 and 65535 (`server.port`, or legacy `port`). Files that omitted the port
used to be assumed to listen on 8317, which was wrong: CPA binds a random port in that case.

## Shutdown

Nothing breaks, but if your host process can be stopped by SIGTERM or SIGINT, add a handler that calls
`stopAllServers()`. Otherwise the CPA process can outlive your host. See the README.

# Migrating from 0.1.0-rc.2

## Management key is optional

You can drop the management key if only the process that calls `startServer` uses the management API:

```ts
// Before
const server = await startServer({ management: { key: process.env.CPA_MANAGEMENT_KEY! }, config });
const client = createClient({ baseUrl: server.origin, managementKey: process.env.CPA_MANAGEMENT_KEY! });

// After
const server = await startServer({ config });
const client = server.client();
```

Behaviour change: without `management`, the management API used to be disabled. It is now enabled, with a key
generated per start, loopback-only by default (`allow-remote: false`). Pass `management: false` to keep it
disabled. Nothing changes with `configPath`, or when you set `config.management['secret-key']` yourself.

## Warnings left `onLog`

cpajs's own warnings used to arrive in `onLog` as lines starting with `cpajs:`. They are now `CpaWarning`s with a
code, printed through `process.emitWarning` or passed to `onWarning`. If you filtered `onLog` for them, use
`onWarning` instead. To silence one, pass `suppressWarnings: { <code>: true }`. A start without a management key
now warns `noManagementKey`; silence it with `suppressWarnings: { noManagementKey: true }` if that is intended.

