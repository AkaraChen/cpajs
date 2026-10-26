// Types for /v8/management/credentials.
// Derived from CLIProxyAPI v8.0.43; see docs/api-coverage.md.

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

export interface CoreAuthQuotaState {
  exceeded: boolean;
  reason?: string;
  next_recover_at: string;
  backoff_level?: number;
  observed_at?: string;
  signals?: Record<string, string>;
}
export interface CoreAuthError { code?: string; message: string; retryable: boolean; http_status?: number }
export interface CoreModelState {
  status: AuthStatus;
  status_message?: string;
  unavailable: boolean;
  next_retry_after: string;
  last_error?: CoreAuthError;
  quota: CoreAuthQuotaState;
  updated_at: string;
}
export interface CoreAuth {
  id: string;
  registration_epoch?: number;
  credential_version?: number;
  generation?: number;
  provider: string;
  prefix?: string;
  label?: string;
  status: AuthStatus;
  status_message?: string;
  disabled: boolean;
  unavailable: boolean;
  proxy_url?: string;
  attributes?: Record<string, string>;
  metadata?: Record<string, unknown>; // contains raw tokens
  quota: CoreAuthQuotaState;
  last_error?: CoreAuthError;
  created_at: string;
  updated_at: string;
  last_refreshed_at: string;
  next_refresh_after: string;
  next_retry_after: string;
  model_states?: Record<string, CoreModelState>;
}
export type RefreshCredentialsResponse =
  | { ok: true; results: ForceRefreshResult[] }
  | { ok: true; auth: CoreAuth };

// ---------- GET /credentials/siwc/status, GET /oauth/siwc/status ----------
export interface SIWCStatusQuery { name?: string; id?: string; auth_index?: string; authIndex?: string }
export interface SIWCStatusResponse { status: SIWCStatus }
