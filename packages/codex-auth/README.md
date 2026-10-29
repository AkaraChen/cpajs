# @cpajs/codex-auth

Sign in with ChatGPT through the Codex device flow and build the auth file that [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) reads.
Zero runtime dependencies, ESM, Node >= 22.

```sh
npm install @cpajs/codex-auth
```

```ts
import { loginWithDeviceCode } from '@cpajs/codex-auth';
import { loginAndUpload } from '@cpajs/codex-auth/cpa';
import { startServer } from '@cpajs/cpa/server';

const server = await startServer();
const client = server.client();

const { name, email, planType } = await loginAndUpload(client, {
  onCode: ({ userCode, verificationUrl }) => console.log(`Open ${verificationUrl} and enter ${userCode}`),
});
```

The constants (client id, issuer, URLs, 15 minute device timeout, 5 second default interval) are the ones the Codex CLI and CPA use.

## Device flow

Stateless primitives, for servers that drive polling from their own requests:

| Function | Request |
| --- | --- |
| `startDeviceAuth()` | `POST /api/accounts/deviceauth/usercode`, returns `{ deviceAuthId, userCode, verificationUrl, intervalSeconds, expiresAt }` |
| `pollDeviceAuth(code)` | one `POST /api/accounts/deviceauth/token`, `{ status: 'pending' }` on 403/404, `{ status: 'approved', grant }` on 2xx |
| `exchangeDeviceGrant(grant)` | `POST /oauth/token` (authorization_code) and parse the id_token |

And the loop built on them, for scripts and CLIs:

- `completeDeviceAuth(code, options)`: first poll immediately, then every `intervalSeconds`; retries network errors until the deadline
  (or `maxNetworkErrors`); any HTTP error other than 403/404 ends the login.
- `loginWithDeviceCode({ onCode, ...options })`: start, call `onCode` (show the code), complete.

Every function takes `CodexAuthOptions`: `fetch`, `issuer`, `clientId`, `now`, `requestTimeoutMs` (default 30 s) and `signal`.
The loop adds `intervalSeconds`, `deadline`, `sleep`, `onPoll` and `maxNetworkErrors`.

**slow_down is defensive.** The OpenAI endpoint signals "not yet" purely with 403/404. Neither the Codex CLI, CPA nor other known clients
see RFC 8628 errors, but `pollDeviceAuth` also understands `authorization_pending`, `slow_down` (the loop then adds 5 s to the interval),
`expired_token` (`CodexDeviceTimeoutError`) and `access_denied` (`CodexHttpError`, code `access_denied`).

## Tokens

`parseIdToken(idToken)` decodes the (unverified) id_token payload into `{ email, accountId, planType, userId?, organizations?, exp?, raw }`.
`planType` is the raw claim, never defaulted or prettified. `jwtExpiry(token)` returns the `exp` of any JWT.

## CPA auth file

```ts
import { buildCpaAuthFile } from '@cpajs/codex-auth';

const { name, content } = buildCpaAuthFile(tokens, { extra: { prefix: 'team-a' } });
```

`content` has exactly the keys of CPA's `CodexTokenStorage` (`type: "codex"`, `id_token`, `access_token`, `refresh_token`, `account_id`,
`email`, `expired`, `last_refresh`, `plan_type`), with RFC3339 UTC timestamps in seconds and `plan_type` defaulting to `free` like CPA's own writer.
`extra` adds top-level keys CPA keeps or reads (`prefix`, `proxy_url`, `note`, `priority`, `disabled`, your own metadata); it cannot override
the reserved keys above (a `TypeError`). The name follows CPA's `CredentialFileName`: `codex[-sha256(accountId)[:8]]-email-plan.json`
(`cpaCodexFileName()`), and can be overridden. `parseCpaAuthFile()` reads a file back and keeps unknown keys such as `siwc`.

Missing email, access token or refresh token throws `CodexIncompleteTokensError`: CPA cannot name or refresh such an account.

### Upload

`@cpajs/codex-auth/cpa` exposes `uploadToCpa(client, tokens, options)` and `loginAndUpload(client, options)`. They only need an object with
`credentials.upload({ name, content })`, which `CpaClient` from `@cpajs/cpa` provides; `@cpajs/cpa` is an optional peer dependency and is
never imported at runtime. `loginAndUpload` returns `{ name, email, accountId, planType }` and no tokens.

## Who refreshes the token

Refresh tokens rotate. After the upload **CPA owns the refresh token**: it refreshes the access token ahead of expiry (96 hours before it
expires for Codex), under a file lock, and rewrites the file. Do not refresh the same token anywhere else, or one side gets
`refresh_token_reused` (`CodexRefreshReusedError`, never retried).

`refreshTokens(refreshToken, { retries })` is for standalone use (no CPA holding the token). `retries` defaults to 0; CPA itself uses 3 attempts
with 1 s and 2 s backoff.

## Errors

All errors extend `CodexAuthError` and carry a stable `code`: `CodexHttpError` (`status`, `step`, `bodyExcerpt` of at most 300 characters),
`CodexDeviceUnavailableError` (usercode 404), `CodexRefreshReusedError`, `CodexDeviceTimeoutError`, `CodexAbortError`, `CodexNetworkError`,
`CodexProtocolError`, `CodexIdTokenError`, `CodexIncompleteTokensError`. Messages and `bodyExcerpt` redact JWT-looking strings and token
fields; `JSON.stringify(error)` contains neither tokens nor the cause.

## Not included

- The browser (PKCE) flow: its redirect URI is registered as `http://localhost:1455/auth/callback`, so it only works on the machine running
  the browser. `@cpajs/cpa`'s client exposes the CPA-hosted flow.
- Usage/quota lookups and plan display names.

## Tests

`pnpm test` uses a scripted fake `fetch` and an injected clock; nothing calls OpenAI. `pnpm test:e2e` (needs `CPA_BINARY`) uploads a file with
fabricated JWTs to a real CPA and checks `credentials.get`.
