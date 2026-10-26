// Types for the CLIProxyAPI v8 configuration document, as read and written by
// `/v8/management/config`. Keys are the native dash-case YAML keys.
//
// All fields are optional: GET returns only what is stored, without defaults.
// `null` may appear wherever a value was explicitly set to null (PATCH keeps
// nulls; on per-key overrides null means "inherit from the group").
// Derived from CLIProxyAPI v8.0.43 internal/config; see docs/api-coverage.md.

/** Duration string ("30s", "1h") – some fields also accept integer seconds. */
export type CpaDuration = string | number;

export interface CpaThinkingSupport {            // registry/model_registry.go:144
  min?: number; max?: number;
  "zero-allowed"?: boolean; "dynamic-allowed"?: boolean;
  "disable-type"?: string; levels?: string[];
}

export interface CpaRequestScopedErrorRule {      // config_types.go:16
  status?: number; match?: string[]; "match-regexr"?: string[];
  action?: "stop" | "stop-and-cooldown" | "continue" | "continue-and-cooldown" | (string & {});
}

export interface CpaModelBase {
  name: string; alias: string; "display-name"?: string; "force-mapping"?: boolean;
  thinking?: CpaThinkingSupport | null;
}
export interface CpaGeminiModel extends CpaModelBase { "max-context-length"?: number; "is-compat"?: boolean }       // :885
export interface CpaClaudeModel extends CpaGeminiModel {}                                                            // :678
export interface CpaCodexModel extends CpaGeminiModel { "support-configuration-update"?: boolean }                   // :778
export interface CpaVertexModel extends CpaModelBase { openapi?: boolean }                                           // vertex_compat.go:77
export interface CpaOpenAICompatModel extends CpaGeminiModel {                                                        // :978
  image?: boolean; "input-modalities"?: string[]; "output-modalities"?: string[]; "use-max-completion-tokens"?: boolean;
}

/** Fields shared by a group and (as overrides; null = inherit) by each key. C:353-357 */
export interface CpaKeyShared<M> {
  priority?: number | null; prefix?: string | null; "proxy-url"?: string | null;
  headers?: Record<string, string> | null; models?: M[] | null; "excluded-models"?: string[] | null;
  "disable-cooling"?: boolean | null; "request-retry"?: number | null;
  "request-scoped-errors"?: CpaRequestScopedErrorRule[] | null;
}
export interface CpaKeyBase<M> extends CpaKeyShared<M> {
  "api-key": string;
  weight?: number | null;            // weighted-round-robin share, max 1_000_000
  /** Injected by GET JSON only; stripped on write. */
  readonly auth_index?: string;
}
export interface CpaGeminiKey extends CpaKeyBase<CpaGeminiModel> {}                                                   // GeminiKey :834
export interface CpaVertexKey extends Omit<CpaKeyBase<CpaVertexModel>, "request-scoped-errors"> {                     // vertex_compat.go:15
  interactions?: boolean | null; openapi?: boolean | null; "openapi-location"?: string | null;
}
export interface CpaCodexKey extends CpaKeyBase<CpaCodexModel> {                                                      // CodexKey :716 (xai, meta alias it)
  websockets?: boolean | null; "alpha-search"?: boolean | null; "disable-codex-cloaking"?: boolean | null;
}
export interface CpaClaudeCloak {                                                                                     // :572
  mode?: string; "strict-mode"?: boolean; "sensitive-words"?: string[]; "cache-user-id"?: boolean;
}
export interface CpaClaudeKey extends CpaKeyBase<CpaClaudeModel> {                                                    // :596
  "rebuild-mid-system-message"?: boolean | null; "native-tool-search"?: boolean | null;
  cloak?: CpaClaudeCloak | null; "fingerprint-profile"?: string | null; "experimental-cch-signing"?: boolean | null;
}
export interface CpaKeyGroup<K, M> extends CpaKeyShared<M> {
  name?: string; "base-url"?: string; keys: K[];
}
export interface CpaOpenAICompatKey {                                                                                 // :964
  "api-key": string; weight?: number | null; "proxy-url"?: string; readonly auth_index?: string;
}
export interface CpaOpenAICompatGroup {                                                                               // :922 (keys replaces api-key-entries)
  name: string; priority?: number; disabled?: boolean; prefix?: string; "base-url": string;
  keys?: CpaOpenAICompatKey[]; models?: CpaOpenAICompatModel[]; headers?: Record<string, string>;
  "support-prompt-cache-key"?: boolean; "disable-cooling"?: boolean | null; "request-retry"?: number | null;
  "request-scoped-errors"?: CpaRequestScopedErrorRule[];
  /** Injected on the group by GET JSON when it has no keys. */
  readonly auth_index?: string;
}

export interface CpaPayloadModelRule {                                                                                 // :551
  name?: string; protocol?: string; headers?: Record<string, string>; "from-protocol"?: string;
  match?: Record<string, unknown>[]; "not-match"?: Record<string, unknown>[]; exist?: string[]; "not-exist"?: string[];
}
export interface CpaPayloadRule { models?: CpaPayloadModelRule[]; params?: Record<string, unknown> }                  // :542
export interface CpaPayloadFilterRule { models?: CpaPayloadModelRule[]; params?: string[] }                           // :534

export interface CpaOAuthModelAlias {                                                                                  // :455
  name: string; alias: string; openapi?: boolean; fork?: boolean; "display-name"?: string; "force-mapping"?: boolean;
}
export interface CpaOAuthModelSetting { name: string; alias?: string; openapi?: boolean; "max-context-length"?: number } // :470

export interface CpaICEServer {                                                                                        // :329
  urls: string[];
  /** Redacted (absent) in GET JSON; omit on write to keep the stored value; "" or null clears it. */
  username?: string | null; credential?: string | null;
}

export interface CpaClaudeHeaderDefaults {                                                                             // :162
  "user-agent"?: string; "package-version"?: string; "runtime-version"?: string; os?: string; arch?: string;
  timeout?: string; timezone?: string; "stabilize-device-profile"?: boolean;
  "anthropic-beta-strip"?: string[]; "anthropic-beta-append"?: string[];
  "inject-diagnostics"?: boolean; "client-request-id"?: string;
}

export interface CpaPluginStoreAuth {                                                                                  // internal/pluginstore/auth.go:27
  match?: string; "apply-to"?: string[]; type?: string; "token-env"?: string; "username-env"?: string;
  "password-env"?: string; "header-name"?: string; "header-value-env"?: string; "allow-insecure"?: boolean;
}
export interface CpaPluginInstanceConfig { enabled?: boolean; priority?: number; [option: string]: unknown }          // :44

export interface CpaConfig {
  "config-version"?: 8;

  models?: { catalog?: string; "codex-catalog"?: string; "devin-catalog"?: string };      // registry/catalog_config.go:11

  server?: {
    host?: string; port?: number; "max-request-body-bytes"?: number; "github-token"?: string;
    "trusted-proxies"?: string[];                         // IP/CIDR, validated (422)
    tls?: { enable?: boolean; cert?: string; key?: string };                              // :336
    "commercial-mode"?: boolean;
    discovery?: {                                                                         // :360
      enabled?: boolean; "service-name"?: string; "service-type"?: string; subtypes?: string[];
      interfaces?: { include?: string[]; exclude?: string[] };
      "auth-required"?: boolean | null; "advertise-management"?: boolean;
    };
  };

  management?: {                                                                          // RemoteManagement :384
    "allow-remote"?: boolean;
    /** NOT redacted by GET. Plaintext on write; persisted as bcrypt hash after watcher reload. */
    "secret-key"?: string;
    "disable-control-panel"?: boolean; "disable-auto-update-panel"?: boolean;
    "panel-github-repository"?: string; "base-url"?: string;
  };

  access?: { "api-keys"?: string[] };

  credentials?: {
    concurrency?: {                                                                       // credential_concurrency.go:23
      /** read-only (400 read_only_field) */ readonly "lifecycle-config-revision"?: number;
      /** read-only */ readonly "observation-barrier-revision"?: number;
      "cpa-heartbeat-timeout"?: CpaDuration; "cpa-cancel-bound"?: CpaDuration; "reclaim-grace"?: CpaDuration;
      "cleanup-interval"?: CpaDuration; "release-flush-interval"?: CpaDuration; "release-max-backoff"?: CpaDuration;
      "busy-retry-min"?: CpaDuration; "busy-retry-max"?: CpaDuration; "max-limit"?: number;
    };
    "in-flight"?: {                                                                       // credential_in_flight.go:18
      "snapshot-interval"?: string; "stale-after"?: string; "max-part-bytes"?: number; "max-part-count"?: number;
      "max-revision-bytes"?: number; "max-aggregate-groups"?: number; "max-details"?: number;
      "max-string-bytes"?: number; "staging-retention"?: string;
    };
  };

  routing?: {                                                                             // RoutingConfig :417 + remaps
    strategy?: "round-robin" | "weighted-round-robin" | "fill-first" | (string & {});
    "session-affinity"?: boolean; "session-affinity-ttl"?: string; "session-affinity-subagents"?: boolean;
    "session-affinity-rebind-on"?: string;
    "force-model-prefix"?: boolean;
    retry?: { "request-retry"?: number; "max-retry-credentials"?: number; "max-retry-interval"?: number };
    cooldown?: { "disable-cooling"?: boolean; "save-cooldown-status"?: boolean; "transient-error-cooldown-seconds"?: number };
  };

  requests?: {
    "proxy-url"?: string; "tls-handshake-timeout-seconds"?: number; "passthrough-headers"?: boolean;
    "nonstream-keepalive-interval"?: number;
    streaming?: { "keepalive-seconds"?: number; "bootstrap-retries"?: number; "send-keepalive-before-ft"?: boolean }; // sdk_config.go:353
    payload?: {                                                                           // :520
      default?: CpaPayloadRule[]; "default-raw"?: CpaPayloadRule[];
      override?: CpaPayloadRule[]; "override-raw"?: CpaPayloadRule[]; filter?: CpaPayloadFilterRule[];
    };
  };

  client?: {                                                                              // sdk_config.go:123
    codex?: {
      "optimize-multi-agent-v2"?: boolean; "enable-apply-patch"?: boolean;
      "web-search-result-cache"?: { enabled?: boolean; ttl?: string | number; limit?: number } | null;
    };
  };

  upstream?: {
    codex?: {                                                                             // CodexConfig :230 (subset)
      "disable-codex-cloaking"?: boolean; "stream-bootstrap-buffering"?: boolean;
      "stream-bootstrap-timeout"?: string; "orphan-delegation-compatibility"?: boolean;
      "model-level-cooling"?: boolean; "response-steering"?: boolean;
    };
    claude?: {                                                                            // ClaudeConfig :115 + ClaudeCodeConfig + remaps
      "model-level-cooling"?: boolean; "tool-search"?: boolean; "session-date-pin-days"?: number | null;
      "disable-claude-cloak-mode"?: boolean; "disable-cloaking-model-list"?: boolean;
      "header-defaults"?: CpaClaudeHeaderDefaults;
    };
    xai?: { "inject-x-search"?: boolean };                                                // :194
  };

  "api-keys"?: {
    gemini?: CpaKeyGroup<CpaGeminiKey, CpaGeminiModel>[];
    interactions?: CpaKeyGroup<CpaGeminiKey, CpaGeminiModel>[];
    vertex?: CpaKeyGroup<CpaVertexKey, CpaVertexModel>[];
    codex?: CpaKeyGroup<CpaCodexKey, CpaCodexModel>[];
    claude?: CpaKeyGroup<CpaClaudeKey, CpaClaudeModel>[];
    xai?: CpaKeyGroup<CpaCodexKey, CpaCodexModel>[];
    meta?: CpaKeyGroup<CpaCodexKey, CpaCodexModel>[];
    "openai-compatibility"?: CpaOpenAICompatGroup[];
  };

  oauth?: {
    "auth-dir"?: string; "auth-auto-refresh-workers"?: number;
    /** keyed by channel: vertex, aistudio, antigravity, claude, codex, kimi, xai, meta, or plugin provider keys */
    "model-alias"?: Record<string, CpaOAuthModelAlias[]>;
    "excluded-models"?: Record<string, string[]>;
    "request-scoped-errors"?: Record<string, CpaRequestScopedErrorRule[]>;
    settings?: Record<string, CpaOAuthModelSetting[]>;
    providers?: {
      aistudio?: { "ws-auth"?: boolean };
      codex?: {
        "live-media-relay"?: {                                                            // :318
          enabled?: boolean; "max-sessions"?: number; "disable-private-remote-ips"?: boolean;
          "public-ip"?: string; "udp-port-min"?: number; "udp-port-max"?: number;
          "ice-servers"?: CpaICEServer[];
        };
        "signin-with-chatgpt-identifier"?: string;
        "header-defaults"?: { "user-agent"?: string; "beta-features"?: string };          // :188
      };
      antigravity?: {                                                                     // :206 + remaps
        "sensitive-words"?: string[];
        "connection-pool"?: { enabled?: boolean; "idle-conn-timeout"?: string; "max-idle-conns-per-host"?: number };
        "antigravity-credits"?: boolean;
        "signature-cache-enabled"?: boolean; "signature-bypass-strict"?: boolean;
      };
      devin?: { "sensitive-words"?: string[] };
    };
  };

  multimedia?: {
    "disable-image-generation"?: boolean | "chat" | "passthrough";
    "gpt-image-2-base-model"?: string; "video-result-auth-cache-ttl"?: string;
  };

  observability?: {
    logs?: { debug?: boolean; "logging-to-file"?: boolean; "logs-max-total-size-mb"?: number;
             "error-logs-max-files"?: number; "request-log"?: boolean };
    usage?: { "usage-statistics-enabled"?: boolean; "redis-usage-queue-retention-seconds"?: number };
    pprof?: { enable?: boolean; addr?: string };
  };

  plugins?: {                                                                             // :28
    enabled?: boolean; dir?: string; "store-sources"?: string[]; "store-auth"?: CpaPluginStoreAuth[];
    /** read-only */ readonly "auth-revision"?: number;
    configs?: Record<string, CpaPluginInstanceConfig>;
  };

  "quota-exceeded"?: { "switch-project"?: boolean; "switch-preview-model"?: boolean };   // :403 (antigravity-credits moved)
}
