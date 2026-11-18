// Types for /v8/management/observability.
// Derived from CLIProxyAPI v8.0.77; see docs/api-coverage.md.

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
  // Present only when the upstream reported them.
  cache_creation_5m_tokens?: number;
  cache_creation_30m_tokens?: number;
  cache_creation_1h_tokens?: number;
  cache_creation_12h_tokens?: number;
  text_input_tokens?: number;
  image_input_tokens?: number;
  audio_input_tokens?: number;
  video_input_tokens?: number;
  file_input_tokens?: number;
  cached_text_tokens?: number;
  cached_image_tokens?: number;
  cached_audio_tokens?: number;
  text_output_tokens?: number;
  image_output_tokens?: number;
  audio_output_tokens?: number;
  accepted_prediction_tokens?: number;
  rejected_prediction_tokens?: number;
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
  fail: { status_code: number; body: string; code?: UsageFailCode | (string & {}) }; // status_code 200 when not failed
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
  home_selection?: UsageHomeSelection; // Home mode only
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
  upstream_service_tier?: string;
  response_model?: string;
  speed?: string;
  inference_geo?: string;
  cache_details?: UsageCacheDetails;
  web_search_requests?: number;
  image_count?: number;
  requested_image_details?: UsageImageDetails;
  image_details?: UsageImageDetails;
  media_counts?: UsageMediaCounts;
  tool_usage_details?: UsageToolDetails;
  iterations?: UsageIteration[];
  cost_details?: UsageCostDetails;
}
export type UsageFailCode = "stream_truncated" | "request_scoped" | "force_cooldown";
export interface UsageHomeSelection { reused: boolean; additional?: boolean; model: string; credential_policy?: string }
export interface UsageCacheDetails {
  mode?: string;
  ttl?: string;
  retention?: string;
  ephemeral_5m_input_tokens?: number;
  ephemeral_30m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
  ephemeral_12h_input_tokens?: number;
  by_ttl?: Record<string, number>;
}
export interface UsageImageDetails {
  size?: string; resolution?: string; image_size?: string; aspect_ratio?: string; quality?: string;
  background?: string; output_format?: string; response_format?: string; mime_type?: string; input_fidelity?: string;
}
export interface UsageMediaCounts { prompt_media?: number; completion_media?: number; prompt_audio?: number; audio_seconds?: number }
export interface UsageToolDetails {
  web_search_calls?: number; web_search_queries?: number; web_fetch_calls?: number; num_search_results?: number;
  num_sources_used?: number; num_server_side_tools_used?: number; tool_calls_requested?: number; tool_calls_executed?: number;
  x_search_calls?: number; x_posts_fetched?: number; x_users_fetched?: number; code_execution_calls?: number;
  file_search_calls?: number; mcp_calls?: number; document_search_calls?: number; image_generation_calls?: number;
  extra?: Record<string, number>;
}
export interface UsageIteration {
  type?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  reasoning_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  cache_creation?: UsageCacheDetails;
}
export interface UsageCostDetails {
  cost?: number;
  cost_in_usd_ticks?: number;
  is_byok?: boolean;
  upstream_inference_cost?: number;
  upstream_inference_prompt_cost?: number;
  upstream_inference_completions_cost?: number;
}
/** Elements are verbatim queued JSON; non-JSON payloads come back as strings. */
export type UsageQueueResponse = Array<UsageQueueRecord | string>;

// ---------- observability/requests/in-flight ----------
// Counts only (in_flight.go:13-40). Always { in_flight: 0, by_provider: {} } in Home mode.
export interface InFlightRequestsResponse {
  in_flight: number;
  oldest_started_at?: string; // RFC 3339, UTC
  by_provider: Record<string, number>;
}
