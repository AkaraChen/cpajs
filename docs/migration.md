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

