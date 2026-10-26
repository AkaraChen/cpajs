// Types for /v8/management/plugins.
// Derived from CLIProxyAPI v8.0.43; see docs/api-coverage.md.

// ---------- plugins ----------
export type PluginConfigFieldType = "string" | "number" | "integer" | "boolean" | "enum" | "array" | "object";
export interface PluginConfigFieldInfo {
  default: unknown;
  name: string;
  type: PluginConfigFieldType | string;
  enum_values: string[] | null;
  description: string;
}
export interface PluginMenuInfo { path: string; menu: string; description: string }
export interface PluginMetadataInfo {
  name: string;
  version: string;
  author: string;
  github_repository: string;
  logo: string;
  config_fields: PluginConfigFieldInfo[];
}
export interface PluginListEntry {
  id: string;
  path: string;
  configured: boolean;
  registered: boolean;
  enabled: boolean;
  effective_enabled: boolean;
  supports_oauth: boolean;
  oauth_provider: string;
  supports_quota: boolean;
  quota_provider?: string;
  logo: string;
  config_fields: PluginConfigFieldInfo[];
  menus: PluginMenuInfo[];
  metadata: PluginMetadataInfo | null;
}
export interface PluginListResponse { plugins_enabled: boolean; plugins_dir: string; plugins: PluginListEntry[] }

export interface DeletePluginResponse {
  status: "deleted";
  id: string;
  path: string;
  file_deleted: boolean;
  configured_removed: boolean;
  restart_required: false;
}

// ---------- plugins/store ----------
export interface PluginStoreSource { id: string; name: string; url: string }
export interface PluginStoreSourceError { source_id: string; source_name: string; source_url: string; message: string }
export interface PluginStorePlatform { goos: string; goarch: string }
export type PluginInstallType = "github-release" | "direct";
export interface PluginStoreListEntry {
  store_id: string; // "<source_id>/<id>"
  source_id: string;
  source_name: string;
  source_url: string;
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  repository: string;
  install_type: PluginInstallType | string;
  auth_required: boolean;
  auth_configured: boolean;
  platforms?: PluginStorePlatform[];
  logo?: string;
  homepage?: string;
  license?: string;
  tags?: string[];
  installed: boolean;
  installed_version: string;
  installed_source_id?: string;
  install_source_status?: "matched" | "different" | "unknown" | "assumed";
  path: string;
  configured: boolean;
  registered: boolean;
  enabled: boolean;
  effective_enabled: boolean;
  update_available: boolean;
}
export interface PluginStoreListResponse {
  plugins_enabled: boolean;
  plugins_dir: string;
  sources: PluginStoreSource[];
  source_errors?: PluginStoreSourceError[];
  plugins: PluginStoreListEntry[];
}
export interface PluginInstallQuery { source?: string; version?: string }
export interface PluginInstallRequest { version?: string }
export interface PluginInstallResponse {
  status: "installed";
  source_id: string;
  source_name: string;
  source_url: string;
  id: string;
  version: string;
  install_type: PluginInstallType | string;
  path: string;
  plugins_enabled: boolean;
  restart_required: boolean; // currently always false on success
}
export interface PluginStoreRateLimitedError {
  error: "plugin_store_rate_limited";
  message: string;
  retry_after: number;
  retry_at: string;
}

// ---------- plugins/:id/quota ----------
export interface PluginQuotaQuery { auth_index: string } // "authIndex" also accepted
export interface PluginQuotaBody {                        // POST / DELETE body
  auth_index?: string;
  authIndex?: string;
  AuthIndex?: string;
}
export interface QuotaSubscription { plan?: string; tierName?: string; tierId?: string }
export interface QuotaBucket { window?: string; remainingFraction: number; resetTime?: string; description?: string }
export interface QuotaGroup { displayName?: string; buckets?: QuotaBucket[] }
export interface QuotaMetric {
  key: string;
  label: string;
  value: number;
  unit?: string;
  format?: "number" | "currency";
  currency?: string;
}
export interface QuotaFetchResponse {
  subscription?: QuotaSubscription;
  summary?: QuotaMetric[];
  serverTimeOffsetMs?: number;
  groups?: QuotaGroup[];
}
export interface PluginQuotaResetResponse { status: "ok"; auth_index: string; message?: string }
