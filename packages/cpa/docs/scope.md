# Scope

cpajs does two things:

1. Run the official CLIProxyAPI binary from Node.js or Bun: locate it, write a managed config, start the
   process, wait for readiness, stream logs, stop it, and restart it on request.
2. Talk to CPA's v8 management API through a typed client that mirrors the routes and payloads of the pinned
   CPA version.

It deliberately does **not** provide downstream policy or high-level workflows. If a helper would copy
CLIProxyAPI's internal logic, define a cpajs-specific convention, or can be written in a few lines by a caller
on top of the primitives, it stays out of cpajs.

## What cpajs manages

- Starting and stopping CPA, readiness, process cleanup, the launcher, and log redaction.
- A managed `config.yaml`: listener fields, management key hashing, the pinned control panel, and the
  `config` function evaluated before a first start and before a manual `restart()`.
- A typed, mostly one-to-one client for `/v8/management`: config documents and paths, credential files,
  OAuth, logs, usage, routing, requests, plugins and server metadata.

## What cpajs does not manage

- Automatic restart, backoff policies, crash-loop accounting, first-start retries, or moving to a new port.
  Call `startServer()` from your own `exited` handler or call `restart()` yourself.
- Lifecycle events other than `exit`. Use `exited`, `stop()`, `restart()` and the handle's getters.
- `afterStart` hooks and their cleanup functions.
- Per-process server reuse (`singleton`) or a global server registry.
- Log filtering. `onLog` receives every redacted line and `LogLine.level` is there for your own filter.
- High-level config mutations (`config.update`, `config.reconcile`), internal serialisation locks, or
  automatic retries of `invalid_config`. Compose `config.getPath` / `config.set` / `config.patchPath` with
  `ifMatch` and your own retry.
- Credential synchronisation (`credentials.reconcile`), `x-cpajs` markers, adoption, listing config keys
  (`credentials.listAll`), or computing models per credential (`credentials.modelsFor`).
- Editing config API keys through `credentials.setStatus` / `credentials.delete`. Those methods pass through
  the upstream file routes only.
- `requests.apiCallJson` and its upstream/token error classes. `requests.apiCall` returns the upstream status
  and body as CPA does.
- Function-valued `baseUrl`.

## The rule for new features

Keep a change only when it fixes a bug in existing cpajs behaviour or faithfully maps behaviour CPA already
has. Do not add a strategy, default or convenience that cpajs invented. A downstream need is not by itself a
reason to add it here: two downstreams wanting the same thing still does not make it a general requirement.

Before opening an issue or PR, compare the request against this document. If it falls in the "does not
manage" list, implement it in the downstream caller on top of the primitives.
