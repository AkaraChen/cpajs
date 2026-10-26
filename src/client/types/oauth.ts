// Types for /v8/management/oauth.
// Derived from CLIProxyAPI v8.0.43; see docs/api-coverage.md.

import type { OkStatus, StatusErrorBody } from './common.ts';

// ---------- POST /oauth/import ----------
export interface OAuthImportQuery { provider: 'vertex'; location?: string }
// multipart: field "file" (service account JSON), optional field "location"
export interface VertexImportResponse {
  status: 'ok';
  'auth-file': string;
  project_id: string;
  email: string;
  location: string;
}

// ---------- GET|POST /oauth/auth-url ----------
export type BuiltinOAuthProvider =
  | 'claude' | 'codex' | 'antigravity' | 'kimi' | 'kimi-ai' | 'xai' | 'devin' | 'meta';
export interface OAuthAuthUrlQuery {
  provider?: BuiltinOAuthProvider | (string & {});
  is_webui?: '1' | 'true' | 'yes' | 'on' | '0' | 'false' | 'no' | 'off';
  domain?: string;  // kimi
  channel?: string; // kimi
  [pluginMeta: string]: string | undefined;
}
export interface OAuthAuthUrlRequest {     // POST only
  provider?: BuiltinOAuthProvider | (string & {});
  proxy_url?: string;
  'proxy-url'?: string;
  domain?: string;
  channel?: string;
  is_webui?: boolean | string;
  [pluginMeta: string]: unknown;
}
export interface OAuthAuthUrlRedirectResponse { status: 'ok'; url: string; state: string }
export interface OAuthAuthUrlDeviceResponse {
  status: 'ok'; url: string; state: string; flow: 'device';
  user_code?: string; expires_in?: number;
}
export type OAuthAuthUrlResponse = OAuthAuthUrlRedirectResponse | OAuthAuthUrlDeviceResponse;

// ---------- POST /oauth/siwc/bind ----------
export interface SIWCBindRequest { name: string }
export interface SIWCBindResponse { status: 'ok'; url: string; state: string; flow: 'siwc_bind'; expires_in: number }

// ---------- GET /oauth/status ----------
export interface OAuthStatusQuery { state?: string }
export type OAuthStatusResponse =
  | { status: 'ok' }
  | { status: 'wait' }
  | { status: 'error'; error: string };

// ---------- DELETE /oauth/session ----------
export interface CancelOAuthSessionQuery { state: string }
export interface CancelOAuthSessionResponse { status: 'ok'; cancelled: boolean }

// ---------- GET|POST /oauth/callback (unauthenticated) ----------
export interface OAuthCallbackQuery {
  provider?: string; state?: string; code?: string;
  error?: string; error_description?: string; client_id?: string;
}
export interface OAuthCallbackRequest {
  provider?: string;
  redirect_url?: string;
  code?: string;
  state?: string;
  error?: string;
  client_id?: string; // required for SIWC bind callbacks
}
export type OAuthCallbackResponse = OkStatus | StatusErrorBody;
