# Changelog

All notable changes to `@cpajs/codex-auth`.

## 0.1.0-rc.7

Initial release.

- Codex device flow: `startDeviceAuth`, `pollDeviceAuth`, `exchangeDeviceGrant`, plus `completeDeviceAuth` and `loginWithDeviceCode`.
- `parseIdToken`, `jwtExpiry`, `refreshTokens`.
- `buildCpaAuthFile`, `cpaCodexFileName`, `parseCpaAuthFile` for the file CLIProxyAPI reads.
- `@cpajs/codex-auth/cpa`: `uploadToCpa`, `loginAndUpload` (optional peer on `@cpajs/cpa`).
