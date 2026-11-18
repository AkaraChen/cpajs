// Types for /v8/management/routing.
// Derived from CLIProxyAPI v8.0.77; see docs/api-coverage.md.

// ---------- routing/cooldown/reset ----------
export interface CooldownResetRequest { auth_index: string }
export interface CooldownResetResponse { status: "ok"; auth_index: string; models: string[] }

// ---------- routing/model-definitions/:channel ----------
export type StaticModelChannel =
  | "claude" | "gemini" | "gemini-interactions" | "vertex" | "aistudio" | "codex"
  | "kimi" | "kimi-ai" | "kimi.ai" | "kimi.com" | "antigravity"
  | "xai" | "x-ai" | "grok" | "devin" | "meta" | "muse";
export interface ThinkingSupport {
  min?: number;
  max?: number;
  zero_allowed?: boolean;
  dynamic_allowed?: boolean;
  disable_type?: string;
  levels?: string[];
}
export interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  type: string;
  display_name?: string;
  name?: string;
  version?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  context_length?: number;
  max_completion_tokens?: number;
  supported_parameters?: string[];
  supportedInputModalities?: string[];
  supportedOutputModalities?: string[];
  supports_web_search?: boolean;
  thinking?: ThinkingSupport;
  config?: { override_header?: Record<string, string> };
}
export interface ModelDefinitionsResponse { channel: string; models: ModelInfo[] }
export interface UnknownChannelError { error: "unknown channel"; channel: string }

// ---------- POST routing/model-definitions/refresh (alias: POST models/refresh) ----------
// One handler (model_definitions.go:14-58); no body. Errors: 400 { ok: false, error } for an invalid
// models.* source; 502 ModelCatalogRefreshFailure when a fetch fails.
export type ModelCatalogName = "catalog" | "codex-catalog" | "devin-catalog";
export interface ModelCatalogSources { catalog?: string; "codex-catalog"?: string; "devin-catalog"?: string }
export interface ModelCatalogStatus {
  source: string;            // URL, absolute path, "embed" or "disabled"
  refreshed: boolean;
  skipped?: true;            // source is "embed" or "disabled"
  changed_providers?: string[];
  error?: string;
}
interface ModelCatalogRefreshFields {
  catalog: string;
  codex_catalog: string;
  devin_catalog: string;
  sources: ModelCatalogSources;
  catalogs: Partial<Record<ModelCatalogName, ModelCatalogStatus>>;
  changed_providers: string[];
}
export interface ModelCatalogRefreshResponse extends ModelCatalogRefreshFields { ok: true; status: "ok" }
export interface ModelCatalogRefreshFailure extends ModelCatalogRefreshFields { ok: false; error: string }
