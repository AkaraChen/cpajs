# v8 management API coverage

Supported CLIProxyAPI version: **v8.0.43** (commit `3078035`). Every route registered in
[`internal/api/server_management_v8.go`](https://github.com/router-for-me/CLIProxyAPI/blob/307803510bce87f986fcf7b1a84190f105c7b4aa/internal/api/server_management_v8.go)
is listed below. Handler references are relative to `internal/api/handlers/management/` at that commit.

Official reference: <https://help.router-for.me/management/apiv8>. The client follows the
pinned source wherever source and docs differ. Each difference is listed in
[Documentation differences](#documentation-differences).

Tests: **U** = unit test with a mocked fetch (`tests/unit/resources.test.ts`, `tests/unit/transport.test.ts`).
**E** = contract test against the real binary (`tests/e2e/contract.test.ts`) on linux-x64-musl and the
plugin-enabled linux-x64-gnu build; plugin store tests use a local registry through `plugins.store-sources`.

## Common behaviour

| Topic | Behaviour (verified against v8.0.43) | Client |
| --- | --- | --- |
| Auth | `Authorization: Bearer <key>`. CPA also accepts a bare `Authorization: <key>` or `X-Management-Key`. Wrong key → 401 `{"error":"invalid management key"}`. Five failures from one IP ban it for 30 minutes, localhost included (handler.go:358-457). | Always sends Bearer; `CpaHttpError.errorCode`. **U E** |
| Remote access | Non-loopback clients need `management.allow-remote`. Setting `MANAGEMENT_PASSWORD` also allows them; cpajs only sets it for `management.viaEnvironment`. | The default `startServer({ management: { key } })` writes a bcrypt hash and leaves `allow-remote` false; `management.viaEnvironment` uses `MANAGEMENT_PASSWORD`, which also allows them. |
| Disabled management | 404 with an empty body and no `X-CPA-*` headers. | `CpaHttpError` with `status: 404`, `data: undefined`. **U** |
| Version headers | `X-CPA-VERSION`, `X-CPA-COMMIT`, `X-CPA-BUILD-DATE`, `X-CPA-SUPPORT-PLUGIN` on every authenticated response, 401/403 included. | `client.server.info()`. **U E** |
| Error bodies | `{"error": string, "message"?: string, ...}`. The oauth status, session and callback routes use `{"status":"error","error": string}`. | `CpaHttpError.status/body/data/errorCode/errorMessage`. **U E** |
| 207 | Multi-file upload or delete with partial failures. | Resolved, not thrown (`status: 'partial'`). **U E** |
| Wrong method or unknown path | 404 with an empty body; gin does not return 405. | `CpaHttpError`. |
| CORS | `OPTIONS` → 204 before auth. | Not used. |

## Routes

### Config: `ConfigV8` (config_v8.go:27)

All config routes are served by one handler. Every read returns a strong `ETag`, which is the SHA-256 of
the file on disk. Every write accepts an optional `If-Match` and returns 412 `precondition_failed` on a
mismatch. A successful write returns `{"status":"ok","config-version":8}`. Writes migrate a legacy file to
v8 and hot-reload it.

| Method | Path | Request | Response | Client method | Tests | Status |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/config` | – | v8 document as JSON. TURN `username`/`credential` are removed and `auth_index` is injected into API keys. | `config.get()` → `{data, etag}` | U E | ✅ |
| PUT | `/config` | JSON object, full replace | write result | `config.replace(doc, {ifMatch})` | U | ✅ |
| PATCH | `/config` | JSON object, deep merge. Arrays replace; `null` is stored, not deleted. | write result | `config.patch(doc, {ifMatch})` | U E | ✅ |
| GET | `/config.yaml` | – | `application/yaml`, lossless (comments kept, nothing redacted) | `config.getYaml()` | U E | ✅ |
| PUT | `/config.yaml` | YAML or JSON | write result | `config.replaceYaml(text)` | U E | ✅ |
| GET | `/config/*path` | – | the node, any JSON value. Missing → 404 `not_found`. | `config.getPath(path)` | U E | ✅ |
| PUT | `/config/*path` | any JSON value. Missing parents are created. | write result | `config.set(path, value)` | U E | ✅ |
| PATCH | `/config/*path` | any JSON value; objects merge | write result | `config.patchPath(path, value)` | U E | ✅ |
| DELETE | `/config/*path` | – | write result. Empty ancestors are pruned; missing → 404. | `config.delete(path)` | U E | ✅ |

Transient read failure: CPA rewrites `config.yaml` non-atomically. It truncates and then writes
(`os.WriteFile` in `internal/config/config_yaml.go:138` when the watcher hashes a plaintext secret, `O_TRUNC` in
`WriteConfig`), and every config read goes to disk. A read that lands inside that window answers
`500 {"error":"invalid_config","message":"empty config"}`. The client reports it like any other error; retry
yourself if a transient read failure is acceptable. Read a node with `config.getPath`, change it, and write it
back with `config.set` / `config.patchPath` plus the ETag as `ifMatch`. Note that `GET /config` strips TURN
`username`/`credential`, so read and write a node rather than the whole document when those matter.

Path rules: segments are dash-case YAML keys. List indices cannot be addressed, so lists are replaced whole.
`%2F` is split, which means a key that contains `/` cannot be addressed. `encodePath` rejects such segments
and empty segments. `DELETE /config` gives a 307 to `/config/`, which returns 400; the client refuses an
empty path. Validation errors: 400 `invalid_config` for unknown sections or legacy keys, 422 for type
errors, 400 `read_only_field` for revision fields. Writing a plaintext management secret makes the watcher
rewrite the file with its bcrypt hash a few seconds later, which changes the ETag (contract-tested).

### Server

| Method | Path | Handler | Client method | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| GET | `/healthz` (root, no auth) | server_routes.go:45 | `server.health()` | U E | ✅ |
| GET | `/server/latest-version` | config_basic.go:48 (calls GitHub) | `server.latestVersion()` → tag string | U | ✅ |
| – | version headers | handler.go:325 | `server.info()` | U E | ✅ |

### Requests

| Method | Path | Handler | Client method | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| POST | `/requests/api-call` | api_tools.go:104 | `requests.apiCall({method, url, header, data, proxy_url, auth_index})` → `{status_code, header, body}`; returns 200 whenever the upstream call completed | U E | ✅ |

### Routing

| Method | Path | Handler | Client method | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| POST | `/routing/cooldown/reset` | quota.go:28 | `routing.resetCooldown(authIndex)` | U E | ✅ |
| GET | `/routing/model-definitions/:channel` | model_definitions.go:15 | `routing.modelDefinitions(channel)` | U E | ✅ |

### Observability

| Method | Path | Handler | Client method | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| GET | `/observability/logs` | logs.go:40 (needs `logging-to-file`) | `logs.get({limit, after, cursor})` | U E | ✅ |
| DELETE | `/observability/logs` | logs.go:135 | `logs.clear()` | U E | ✅ |
| GET | `/observability/logs/errors` | logs.go:197 | `logs.listErrorLogs()` | U E | ✅ |
| GET | `/observability/logs/errors/:name` | logs.go:430 (attachment) | `logs.downloadErrorLog(name)` → `{filename, blob}` | U E | ✅ |
| GET | `/observability/logs/requests/:id` | logs.go:261 (attachment; matches the last 8 chars of the ID) | `logs.downloadRequestLog(id)` | U E | ✅ |
| GET | `/observability/usage/api-keys` | api_key_usage.go:58 (raw keys in map keys) | `usage.apiKeys()` | U E | ✅ |
| GET | `/observability/usage/queue` | usage.go:24 (**destructive pop**) | `usage.popQueue(count)` | U E | ✅ |

### Credentials

| Method | Path | Handler | Client method | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| GET | `/credentials` | auth_files.go:106 (`name`, `auth_index`, `page`, `page_size`) | `credentials.list(query)`, `credentials.get(name)` | U E | ✅ |
| POST | `/credentials` (raw) | auth_files_crud.go:116, via oauth_siwc_mutations.go:17 | `credentials.upload({name, content})` | U E | ✅ |
| POST | `/credentials` (multipart) | auth_files_crud.go:231 | `credentials.uploadMany(files)` | U E | ✅ |
| DELETE | `/credentials` | auth_files_crud.go:142 via oauth_siwc_mutations.go:23 | `credentials.delete(name or names)`, `credentials.deleteAll()` | U E | ✅ |
| GET | `/credentials/models` | auth_files.go:336 | `credentials.models(name)` | U E | ✅ |
| GET | `/credentials/download` | auth_files_crud.go:28 (attachment) | `credentials.download(name)` → `Blob` | U E | ✅ |
| PATCH | `/credentials/status` | auth_files_fields.go:29 | `credentials.setStatus({name, disabled, auth_index?})` | U E | ✅ |
| PATCH | `/credentials/fields` | auth_files_fields.go:262 | `credentials.patchFields({name, ...fields})` | U E | ✅ |
| POST | `/credentials/refresh` | auth_files_refresh.go:15 | `credentials.refresh(selector)`, `credentials.refreshAll()` | U E | ✅ |
| GET | `/credentials/siwc/status` | oauth_siwc.go:140 | `credentials.siwcStatus(selector)` | U | ✅ |

E2E covers the success response shape with an API-key credential (its executor has no token to rotate) and
the missing-file 404. Rotation against a real provider needs provider tokens and stays unit-only.

### OAuth

| Method | Path | Handler | Client method | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| GET, POST | `/oauth/auth-url` | auth_files_v8.go:119 | `oauth.start(request)` (always POST, so `proxy_url` is allowed) | U E | ✅ |
| GET | `/oauth/status` | auth_files_provider_oauth.go:984 | `oauth.status(state)`, `oauth.waitForCompletion(state)` | U E | ✅ |
| DELETE | `/oauth/session` | auth_files_provider_oauth.go:970 | `oauth.cancel(state)` | U E | ✅ |
| GET, POST | `/oauth/callback` (no auth) | oauth_siwc.go:315/324 | `oauth.callback(body)` (POST) | U E | ✅ |
| POST | `/oauth/import` | auth_files_v8.go:279 → vertex_import.go:18 | `oauth.importVertex({serviceAccount, location})` | U E | ✅ |
| POST | `/oauth/siwc/bind` | oauth_siwc.go:195 | `oauth.siwcBind(name)` | U | ✅ |
| GET | `/oauth/siwc/status` | oauth_siwc.go:140 | `oauth.siwcStatus(selector)` | U | ✅ |

The OAuth tests in CI never talk to a real provider, but `oauth.importVertex` is exercised end to end with a
generated RSA service-account key. They start a session, which only generates PKCE and a
URL, then poll, cancel, and fail a session through the callback route. To test against a real account,
run [`examples/oauth-login.ts`](../examples/oauth-login.ts) or follow these steps by hand:

1. Start a server with a management key: `startServer({ management: { key } })`.
2. Call `client.oauth.start({ provider: 'claude' })` and open `url` in a browser on the same machine.
   If the browser runs on another machine, pass `is_webui: true` or paste the final redirect URL into
   `client.oauth.callback({ redirect_url })`.
3. `await client.oauth.waitForCompletion(state)` should resolve `{ status: 'ok' }`.
4. `client.credentials.list()` now shows the new credential.

### Plugins

| Method | Path | Handler | Client method | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| GET | `/plugins` | plugins.go:68 | `plugins.list()` | U E | ✅ |
| DELETE | `/plugins/:id` | plugins.go:324 | `plugins.delete(id)` | U E | ✅ |
| GET | `/plugins/store` | plugin_store.go:120 (network) | `plugins.store()` | U E | ✅ |
| POST | `/plugins/store/:id/install` | plugin_store.go:221 (network) | `plugins.install(id, {source, version})` | U E | ✅ |
| GET | `/plugins/:id/quota` | plugin_quota.go:238 | `plugins.quota(id, authIndex)` | U E | ✅ |
| POST | `/plugins/:id/quota` | plugin_quota.go:252 | covered by `plugins.quota`; the handler is identical (`fetchQuotaForPlugin`) | – | ✅ (equivalent) |
| DELETE | `/plugins/:id/quota` | plugin_quota.go:302 | `plugins.resetQuota(id, authIndex)` | U E | ✅ |

E2E installs a direct plugin from a local registry served by the test. Upstream always probes its built-in
official registry first, so an offline run records that source error but still lists and installs the local
plugin. Quota and resetQuota are covered end to end for their 400/404 error paths; a successful reset needs
an installed plugin with a quota provider.

Any other route can be called through `client.request({ method, path, query, json, body, responseType })`.

## Documentation differences

These are differences between the official docs and the v8.0.43 source. The client follows the source.

| Topic | Docs | Source (v8.0.43) |
| --- | --- | --- |
| SIWC routes | Not listed | `POST /oauth/siwc/bind`, `GET /oauth/siwc/status` and `GET /credentials/siwc/status` exist. |
| `/oauth/auth-url` | `GET` only | `POST` is also registered and is the only way to send `proxy_url` (it is refused in the query). |
| ETag / If-Match | Not mentioned | Every config route returns a strong ETag and honours `If-Match` (412 on mismatch). |
| `GET /credentials` pagination | Not mentioned | `page` / `page_size` enable `total`, `page`, `page_size` and `has_more`. |
| `DELETE /credentials` | `name` or `all=true` | Repeated `name`, a JSON body of names, and `all=1` / `all=*` also work. Partial failure returns 207. |
| `PUT /config.yaml` content type | `application/yaml` | The content type is never inspected. JSON bodies are accepted. |
| `secret-key` persistence | "hashed on startup" | It is also hashed after a management write: the watcher rewrites the file a few seconds later, which changes the ETag. |
| Management password env | Not mentioned on this page | `MANAGEMENT_PASSWORD` enables management, allows remote access and is compared in plaintext. Prefer `management: { key }`, which writes a bcrypt hash. |
