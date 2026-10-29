# Changelog

All notable changes to `@cpajs/codex-auth`.

## Unreleased

First release through the release workflow, at the version shared with `@cpajs/cpa`. `0.1.0-rc.6` was a
manual bootstrap publish of the initial code, without the changes listed under Fixed and Changed.

### Fixed

- `buildCpaAuthFile` accepts names containing `..`, so an email such as `first..last@example.com` no longer
  fails. Names are checked with CLIProxyAPI's own rule (no path separators, no drive prefix).

### Changed

- `CodexIncompleteTokensError` has `missing`, the fields that were absent (for example `['email']`), so callers
  no longer match on the message.
- The `fetch` option is typed as `FetchLike`, a plain `(input, init) => Promise<Response>`, instead of
  `typeof fetch`, so test doubles need no cast under Bun. `FetchLike` is exported.

### Added

- Codex device flow: `startDeviceAuth`, `pollDeviceAuth`, `exchangeDeviceGrant`, plus `completeDeviceAuth` and `loginWithDeviceCode`.
- `parseIdToken`, `jwtExpiry`, `refreshTokens`.
- `buildCpaAuthFile`, `cpaCodexFileName`, `parseCpaAuthFile` for the file CLIProxyAPI reads.
- `@cpajs/codex-auth/cpa`: `uploadToCpa`, `loginAndUpload` (optional peer on `@cpajs/cpa`).
