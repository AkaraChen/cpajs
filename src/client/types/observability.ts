// Types for /v8/management/observability.
// Derived from CLIProxyAPI v8.0.43; see docs/api-coverage.md.

import type { RecentRequestBucket } from './common.ts';

// ---------- observability/logs ----------
export interface GetLogsQuery {
  limit?: number;   // positive integer
  after?: number;   // unix seconds; ignored when cursor is set
  cursor?: string;  // opaque, from next-cursor
}
export interface GetLogsResponse {
  lines: string[];
  "line-count": number;       // returned count (cursor/tail) or total scanned (legacy after-scan)
  "latest-timestamp": number; // unix seconds
  "next-cursor": string;      // opaque base64url; may be ""
  "cursor-reset"?: true;      // present only when the supplied cursor was invalid/stale
}
export interface DeleteLogsResponse { success: true; message: string; removed: number }

export interface RequestErrorLogFile { name: string; size: number; modified: number /* unix seconds */ }
export interface RequestErrorLogsResponse { files: RequestErrorLogFile[] }
// GET logs/errors/:name and logs/requests/:id return a file attachment (text). Client should return Blob/ArrayBuffer/text + filename from Content-Disposition.

// ---------- observability/usage/api-keys ----------
export interface ApiKeyUsageEntry { success: number; failed: number; recent_requests: RecentRequestBucket[] /* 20 x 10min */ }
/** provider -> "<base_url>|<api_key>" -> entry */
export type ApiKeyUsageResponse = Record<string, Record<string, ApiKeyUsageEntry>>;

// ---------- observability/usage/queue (DESTRUCTIVE pop) ----------
export interface UsageQueueQuery { count?: number /* positive int, default 1 */ }
export interface UsageTokenStats {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_read_tokens: number;
  cache_read_tokens_present: boolean;
  cache_creation_tokens: number;
  total_tokens: number;
}
export interface UsageTokenBreakdown {
  schema_version: number; // 2
  quality: "complete" | "inconsistent" | "unclassified";
  total_tokens: number;
  input: { total_tokens: number; uncached_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
  output: { total_tokens: number; non_reasoning_tokens: number; reasoning_tokens: number };
  unclassified_tokens: number;
}
export interface UsageQueueRecord {
  timestamp: string;              // RFC3339
  latency_ms: number;
  ttft_ms: number;
  source: string;
  auth_index: string;
  access_token_sha256?: string;
  client_ip: string;
  resolved_client_ip: string;
  x_forwarded_for: string;
  user_agent: string;
  tokens: UsageTokenStats;
  failed: boolean;
  generate: boolean;
  stream: boolean;
  fail: { status_code: number; body: string }; // status_code 200 when not failed
  response_headers?: Record<string, string[]>;
  accounting_version: number;
  token_breakdown: UsageTokenBreakdown;
  provider: string;
  executor_type: string;
  model: string;
  alias: string;
  endpoint: string;
  auth_type: string;
  api_key: string;
  is_native_key: boolean;
  access_provider?: string;
  request_id: string;
  execution_id?: string;
  trace_id?: string;
  session_id?: string;
  parent_session_id?: string;
  node_kind?: string;
  is_fork?: boolean;
  is_compaction?: boolean;
  reasoning_effort: string;
  service_tier: string;
  effective_service_tier?: string;
  response_service_tier?: string;
  response_model?: string;
}
/** Elements are verbatim queued JSON; non-JSON payloads come back as strings. */
export type UsageQueueResponse = Array<UsageQueueRecord | string>;
