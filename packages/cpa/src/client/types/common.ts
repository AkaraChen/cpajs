// Shared response types.
// Derived from CLIProxyAPI v8.0.43; see docs/api-coverage.md.

export interface StatusErrorBody { status: 'error'; error: string }
export interface OkStatus { status: 'ok' }

export type AuthStatus = 'unknown' | 'active' | 'pending' | 'refreshing' | 'error' | 'disabled';
export type SIWCStatus = 'off' | 'valid' | 'invalid';
export type CooldownReason =
  | 'credential_quota' | 'quota' | 'cloudflare_challenge' | 'model_not_supported'
  | 'invalid_grant' | 'unauthorized' | 'payment_required' | 'not_found'
  | 'transient_error' | 'unknown';

/** Any JSON value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Ten-minute request bucket; `time` is `"HH:MM-HH:MM"` in the server's local time. */
export interface RecentRequestBucket { time: string; success: number; failed: number }

export interface PartialFailure { name: string; error: string }

/** Error body from the auth middleware and most ops handlers. */
export interface CpaSimpleError { error: string }
/** Error body from latest-version, plugins, plugin store, plugin delete. */
export interface CpaCodedError {
  error: string;          // machine code, e.g. "plugin_not_found"
  message: string;
  [extra: string]: unknown; // restart_required, path, file_deleted, sources, retry_after, retry_at, ...
}
export type CpaErrorBody = CpaSimpleError | CpaCodedError;

/** Auth outcomes: 401 missing/invalid key; 403 banned / remote disabled / key not set; 404 management disabled (empty body). */
export type ManagementAuthErrorMessage =
  | "missing management key"
  | "invalid management key"
  | "remote management disabled"
  | "remote management key not set"
  | `IP banned due to too many failed attempts. Try again in ${string}`;
