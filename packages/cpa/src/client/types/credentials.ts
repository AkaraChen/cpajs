// Types for /v8/management/credentials.
// Derived from CLIProxyAPI v8.0.77; see docs/api-coverage.md.

import type { AuthStatus, CooldownReason, OkStatus, PartialFailure, RecentRequestBucket, SIWCStatus } from './common.ts';

// ---------- GET /credentials ----------
export interface ListCredentialsQuery {
  name?: string;
  auth_index?: string;
  page?: number;      // >= 1; presence of page or page_size enables pagination
  page_size?: number; // >= 1, default 50
}

export interface QuotaObservation {
  observed_at?: string;
  signals: Record<string, string>;
}

export interface CooldownView {
  scope: 'credential' | 'model';
  model_key?: string;
  reason: CooldownReason | (string & {});
  retry_at: string;
  remaining_seconds: number;
  backoff_level?: number;
  http_status?: number;
}

export interface CodexIdTokenClaims {
  chatgpt_account_id?: string;
  plan_type?: string;
  chatgpt_subscription_active_start?: unknown;
  chatgpt_subscription_active_until?: unknown;
}

export interface AuthFileEntry {
  id: string;
  auth_index: string;
  name: string;
  type: string;
  provider: string;
  label: string;
  status: AuthStatus;
  status_message: string;
  disabled: boolean;
  unavailable: boolean;
  runtime_only: boolean;
  source: 'file' | 'memory';
  size: number;
  success: number;
  failed: number;
  recent_requests: RecentRequestBucket[];
  quota: QuotaObservation;
  cooldowns: CooldownView[] | null;

  model_quotas?: Record<string, QuotaObservation>;
  supports_quota?: true;
  quota_provider?: string;
  quota_plugin_id?: string;
  email?: string;
  project_id?: string;
  account_type?: 'oauth' | 'api_key';
  account?: string;
  created_at?: string;
  modtime?: string;
  updated_at?: string;
  last_refresh?: string;
  next_retry_after?: string;
  path?: string;
  id_token?: CodexIdTokenClaims;
  priority?: number;
  note?: string;
  weight?: number;
  websockets?: boolean;
  request_retry?: number;
  // codex only (v8)
  siwc_bind_supported?: boolean;
  use_siwc?: boolean;
  siwc_status?: SIWCStatus;
  siwc_bound?: boolean;
  siwc_expires_at?: string;
  // v8 renewal / recovery view (auth_files.go:804-865)
  /** Login entry the credential was signed in through (multi-entry OAuth plugins). */
  oauth_provider?: string;
  access_token_expires_at?: string; // RFC 3339
  next_refresh_after?: string;      // RFC 3339; only while in the future
  requires_sign_in: boolean;
  renewal_state: RenewalState | (string & {});
  recovery_stage: RecoveryStage | (string & {});
  quota_blocked: boolean;
  adopted: boolean;
  adopted_at?: string;
  inference_verified: boolean;
  last_inference_verified_at?: string;
  renewal_verified: boolean;
  last_renewal_verified_at?: string;
  refresh_error?: CredentialRefreshError;
  /** Present when `requires_sign_in` is true. */
  next_action?: 'sign_in';
  recovery_hint?: string;
  renewal_event?: RenewalSignInRequiredEvent;
  // Antigravity TOS_VIOLATION deactivation (auth_files.go:704-711)
  tos_appeal_url?: string;
  tos_appeal_url_text?: string;
}

export type RenewalState =
  | 'sign_in_required' | 'expired_sign_in_required' | 'retry_scheduled' | 'renewal_verified' | 'awaiting_first_renewal';
export type RecoveryStage =
  | 'sign_in_required' | 'credential_saved' | 'quota_blocked' | 'renewal_verified' | 'inference_verified' | 'loaded';
export interface CredentialRefreshError { code: string; message: string; http_status: number }
export interface RenewalSignInRequiredEvent {
  type: 'renewal_sign_in_required';
  auth_id: string;
  provider: string;
  next_action: 'sign_in';
  occurred_at?: string;
  account?: string;
  access_token_expires_at?: string;
}

export interface ListCredentialsResponse {
  observed_at: string;
  files: AuthFileEntry[];
  total?: number;
  page?: number;
  page_size?: number;
  has_more?: boolean;
}

// ---------- POST /credentials ----------
// multipart: any field names, one or more .json files; or raw JSON body + ?name=<file>.json
export interface UploadCredentialRawQuery { name: string }
export type UploadCredentialsResponse =
  | { status: 'ok' }                                              // single file / raw
  | { status: 'ok'; uploaded: number; files: string[] }           // multi, 200
  | { status: 'partial'; uploaded: number; files: string[]; failed: PartialFailure[] }; // 207

// ---------- DELETE /credentials ----------
export interface DeleteCredentialsQuery { name?: string | string[]; all?: 'true' | '1' | '*' }
export type DeleteCredentialsBody = string[] | { name?: string; names?: string[] };
export type DeleteCredentialsResponse =
  | { status: 'ok' }                                              // single
  | { status: 'ok'; deleted: number }                             // all=true
  | { status: 'ok'; deleted: number; files: string[] }            // multi, 200
  | { status: 'partial'; deleted: number; files: string[]; failed: PartialFailure[] }; // 207

// ---------- GET /credentials/models ----------
export interface CredentialModelsQuery { name: string }
export interface CredentialModel { id: string; display_name?: string; type?: string; owned_by?: string }
export interface CredentialModelsResponse { models: CredentialModel[] }

// ---------- GET /credentials/download ----------
export interface DownloadCredentialQuery { name: string } // must end with .json
// response: raw credential JSON (Record<string, unknown>)

// ---------- PATCH /credentials/status ----------
export interface PatchCredentialStatusRequest { name: string; auth_index?: string; disabled: boolean }
export type PatchCredentialStatusResponse =
  | { status: 'ok'; disabled: boolean }
  | { status: 'ok'; disabled: boolean; via: 'config:excluded-models'; excluded_pattern: string };

// ---------- PATCH /credentials/fields ----------
export interface PatchCredentialFieldsRequest {
  name: string;
  priority?: number | null;
  note?: string | null;
  weight?: number | null;
  request_retry?: number | null;
  websockets?: boolean | null;
  disabled?: boolean | null;
  prefix?: string | null;
  proxy_url?: string | null;
  headers?: Record<string, string> | null; // merged; "" deletes a header
  excluded_models?: string[] | null;
  [fieldPath: string]: unknown;            // arbitrary metadata, dotted paths allowed
}
export type PatchCredentialFieldsResponse = OkStatus;

// ---------- POST /credentials/refresh ----------
export interface RefreshCredentialsQuery { all?: 'true'; name?: string; auth_index?: string }
export interface RefreshCredentialsRequest { name?: string; auth_index?: string; all?: boolean }
export interface ForceRefreshResult { id: string; success: boolean; error?: string }

/** Single refresh on v8 returns the redacted list entry, not the raw auth record (CPA >= v8.0.50). */
export type RefreshCredentialsResponse =
  | { ok: true; results: ForceRefreshResult[] }
  | { ok: true; auth: AuthFileEntry };

// ---------- POST /credentials/verify ----------
// Runs a minimal inference pinned to one credential (auth_files_v8.go:544-649). Fields may be sent
// as query or JSON body; query wins. Errors: 400/404/503 as CpaSimpleError, 409/502/upstream status
// as VerifyCredentialErrorBody.
export interface VerifyCredentialRequest {
  name?: string;           // also accepted as target_auth_id / auth_id
  target_auth_id?: string;
  auth_id?: string;
  auth_index?: string;
  model?: string;          // defaults to the credential's first registered model
}
export interface VerifyCredentialResponse {
  status: 'ok';
  verified: boolean;
  recovery_stage?: RecoveryStage | (string & {});
  renewal_state?: RenewalState | (string & {});
  inference_verified?: boolean;
  credential?: AuthFileEntry;
}
export interface VerifyCredentialErrorBody {
  status: 'error';
  verified: false;
  error: string;
  recovery_stage?: RecoveryStage | (string & {});
  renewal_state?: RenewalState | (string & {});
  quota_blocked?: boolean;
  credential?: AuthFileEntry;
}

// ---------- GET /credentials/siwc/status, GET /oauth/siwc/status ----------
export interface SIWCStatusQuery { name?: string; id?: string; auth_index?: string; authIndex?: string }
export interface SIWCStatusResponse { status: SIWCStatus }
