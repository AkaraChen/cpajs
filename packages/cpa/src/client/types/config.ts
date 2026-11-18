// Types for the CLIProxyAPI v8 configuration document, as read and written by
// `/v8/management/config`. Keys are the native dash-case YAML keys.
//
// All fields are optional: GET returns only what is stored, without defaults.
// `null` may appear wherever a value was explicitly set to null (PATCH keeps
// nulls; on per-key overrides null means "inherit from the group").
// Derived from CLIProxyAPI v8.0.77 internal/config; see docs/api-coverage.md.

/** Duration string ("30s", "1h") – some fields also accept integer seconds. */
export type CpaDuration = string | number;

export interface CpaThinkingSupport {            // registry ThinkingSupport
  min?: number; max?: number;
  "zero-allowed"?: boolean; "dynamic-allowed"?: boolean;
  "disable-type"?: string; levels?: string[];
}

export interface CpaRequestScopedErrorRule {      // RequestScopedErrorRule
  status?: number; match?: string[]; "match-regexr"?: string[];
  action?: "stop" | "stop-and-cooldown" | "continue" | "continue-and-cooldown" | (string & {});
}

export interface CpaModelBase {
  name: string; alias: string; "display-name"?: string; "force-mapping"?: boolean;
  thinking?: CpaThinkingSupport | null;
}
export interface CpaGeminiModel extends CpaModelBase { "max-context-length"?: number; "is-compat"?: boolean }       // GeminiModel
export interface CpaClaudeModel extends CpaGeminiModel {}                                                            // ClaudeModel
export interface CpaCodexModel extends CpaGeminiModel { "support-configuration-update"?: boolean }                   // CodexModel
export interface CpaVertexModel extends CpaModelBase { openapi?: boolean }                                           // VertexCompatModel
export interface CpaOpenAICompatModel extends CpaGeminiModel {                                                        // OpenAICompatibilityModel
  image?: boolean; "input-modalities"?: string[]; "output-modalities"?: string[]; "use-max-completion-tokens"?: boolean;
}

/** Fields shared by a group and (as overrides; null = inherit) by each key. */
export interface CpaKeyShared<M> {
  priority?: number | null; prefix?: string | null; "proxy-url"?: string | null;
  headers?: Record<string, string> | null; models?: M[] | null; "excluded-models"?: string[] | null;
  "disable-cooling"?: boolean | null; "request-retry"?: number | null;
  "request-scoped-errors"?: CpaRequestScopedErrorRule[] | null;
  /** Per-credential upstream connection reuse; omitted = a fresh transport per request. */
  "connection-pool"?: CpaConnectionPool | null;
}
export interface CpaKeyBase<M> extends CpaKeyShared<M> {
  "api-key": string;
  weight?: number | null;            // weighted-round-robin share, max 1_000_000
  /** Injected by GET JSON only; stripped on write. */
  readonly auth_index?: string;
}
export interface CpaGeminiKey extends CpaKeyBase<CpaGeminiModel> {}                                                   // GeminiKey
export interface CpaVertexKey extends Omit<CpaKeyBase<CpaVertexModel>, "request-scoped-errors"> {                     // VertexCompatKey
  interactions?: boolean | null; openapi?: boolean | null; "openapi-location"?: string | null;
}
export interface CpaCodexKey extends CpaKeyBase<CpaCodexModel> {                                                      // CodexKey (xai, meta alias it)
  websockets?: boolean | null; "alpha-search"?: boolean | null; "disable-codex-cloaking"?: boolean | null;
}
export interface CpaConnectionPool { enabled?: boolean; "idle-conn-timeout"?: string; "max-idle-conns-per-host"?: number }
/** Go RE2 pattern and its replacement. */
export interface CpaSensitivePatternRule { pattern: string; replacement: string }
export interface CpaSensitiveReplace {
  /** word -> replacement */
  "sensitive-words-replace"?: Record<string, string>;
  "sensitive-patterns-replace"?: CpaSensitivePatternRule[];
}
export interface CpaClaudeCloak extends CpaSensitiveReplace {                                                         // CloakConfig
  mode?: string; "strict-mode"?: boolean; "sensitive-words"?: string[]; "cache-user-id"?: boolean;
}
export interface CpaClaudeKey extends CpaKeyBase<CpaClaudeModel> {                                                    // ClaudeKey
  "rebuild-mid-system-message"?: boolean | null; "native-tool-search"?: boolean | null;
  cloak?: CpaClaudeCloak | null; "fingerprint-profile"?: string | null; "experimental-cch-signing"?: boolean | null;
}
export interface CpaKeyGroup<K, M> extends CpaKeyShared<M> {
  name?: string; "base-url"?: string; keys: K[];
}
export interface CpaOpenAICompatKey {                                                                                 // OpenAICompatibilityAPIKey
  "api-key": string; weight?: number | null; "proxy-url"?: string; "connection-pool"?: CpaConnectionPool;
  readonly auth_index?: string;
}
export interface CpaOpenAICompatGroup {                                                                               // OpenAICompatibility (keys replaces api-key-entries)
  name: string; priority?: number; disabled?: boolean; prefix?: string; "base-url": string;
  keys?: CpaOpenAICompatKey[]; models?: CpaOpenAICompatModel[]; headers?: Record<string, string>;
  "support-prompt-cache-key"?: boolean; "disable-cooling"?: boolean | null; "request-retry"?: number | null;
  "request-scoped-errors"?: CpaRequestScopedErrorRule[];
  "connection-pool"?: CpaConnectionPool;
  /** Injected on the group by GET JSON when it has no keys. */
  readonly auth_index?: string;
}

export interface CpaPayloadModelRule {                                                                                 // PayloadModelRule
  name?: string; protocol?: string; headers?: Record<string, string>; "from-protocol"?: string;
  match?: Record<string, unknown>[]; "not-match"?: Record<string, unknown>[]; exist?: string[]; "not-exist"?: string[];
}
export interface CpaPayloadRule { models?: CpaPayloadModelRule[]; params?: Record<string, unknown> }                  // PayloadRule
export interface CpaPayloadFilterRule { models?: CpaPayloadModelRule[]; params?: string[] }                           // PayloadFilterRule
/** Text replacement inside messages (payload_replace.go). Invalid rules are dropped with a warning. */
export interface CpaPayloadReplaceRule {
  models?: CpaPayloadModelRule[];
  target?: { role?: "user" | "system" | "developer" | (string & {}); positions?: number[]; all?: boolean; paths?: string[] };
  /** Each entry maps the text (or regex) to find to its replacement. */
  replacements?: Record<string, string>[];
}

export interface CpaOAuthModelAlias {                                                                                  // OAuthModelAlias
  name: string; alias: string; openapi?: boolean; fork?: boolean; "display-name"?: string; "force-mapping"?: boolean;
}
export interface CpaOAuthModelSetting { name: string; alias?: string; openapi?: boolean; "max-context-length"?: number } // OAuthModelSetting

export interface CpaICEServer {                                                                                        // CodexLiveICEServer
  urls: string[];
  /** Redacted (absent) in GET JSON; omit on write to keep the stored value; "" or null clears it. */
  username?: string | null; credential?: string | null;
}

export interface CpaClaudeHeaderDefaults {                                                                             // ClaudeHeaderDefaults
  "user-agent"?: string; "package-version"?: string; "runtime-version"?: string; os?: string; arch?: string;
  timeout?: string; timezone?: string; "stabilize-device-profile"?: boolean;
  "anthropic-beta-strip"?: string[]; "anthropic-beta-append"?: string[];
  "inject-diagnostics"?: boolean; "client-request-id"?: string; "native-entrypoints"?: string[];
}

export interface CpaPluginStoreAuth {                                                                                  // pluginstore AuthConfig
  match?: string; "apply-to"?: string[]; type?: string; "token-env"?: string; "username-env"?: string;
  "password-env"?: string; "header-name"?: string; "header-value-env"?: string; "allow-insecure"?: boolean;
}
export interface CpaPluginInstanceConfig { enabled?: boolean; priority?: number; [option: string]: unknown }          // PluginInstanceConfig

export interface CpaConfig {
  "config-version"?: 8;

  models?: { catalog?: string; "codex-catalog"?: string; "devin-catalog"?: string };      // registry CatalogSources

  server?: {
    host?: string; port?: number; "max-request-body-bytes"?: number; "github-token"?: string;
    "trusted-proxies"?: string[];                         // IP/CIDR, validated (422)
    tls?: { enable?: boolean; cert?: string; key?: string };                              // TLSConfig
    "commercial-mode"?: boolean;
    /** Seconds to drain in-flight requests on shutdown; 0 = off. */
    "shutdown-timeout"?: number;
    /** Local bbolt store; default path `<auth-dir>/kv.db`. */
    "kv-store"?: { disabled?: boolean; path?: string };
    "response-compression"?: { enabled?: boolean; "min-bytes"?: number };
    discovery?: {                                                                         // DiscoveryConfig
      enabled?: boolean; "service-name"?: string; "service-type"?: string; subtypes?: string[];
      interfaces?: { include?: string[]; exclude?: string[] };
      "auth-required"?: boolean | null; "advertise-management"?: boolean;
    };
  };

  management?: {                                                                          // RemoteManagement
    "allow-remote"?: boolean;
    /** NOT redacted by GET. Plaintext on write; persisted as bcrypt hash after watcher reload. */
    "secret-key"?: string;
    "disable-control-panel"?: boolean; "disable-auto-update-panel"?: boolean;
    "panel-github-repository"?: string; "base-url"?: string;
  };

  access?: { "api-keys"?: string[] };

  credentials?: {
    concurrency?: {                                                                       // CredentialConcurrencyConfig
      /** read-only (400 read_only_field) */ readonly "lifecycle-config-revision"?: number;
      /** read-only */ readonly "observation-barrier-revision"?: number;
      "cpa-heartbeat-timeout"?: CpaDuration; "cpa-cancel-bound"?: CpaDuration; "reclaim-grace"?: CpaDuration;
      "cleanup-interval"?: CpaDuration; "release-flush-interval"?: CpaDuration; "release-max-backoff"?: CpaDuration;
      "busy-retry-min"?: CpaDuration; "busy-retry-max"?: CpaDuration; "max-limit"?: number;
    };
    "in-flight"?: {                                                                       // CredentialInFlightConfig
      "snapshot-interval"?: string; "stale-after"?: string; "max-part-bytes"?: number; "max-part-count"?: number;
      "max-revision-bytes"?: number; "max-aggregate-groups"?: number; "max-details"?: number;
      "max-string-bytes"?: number; "staging-retention"?: string;
    };
  };

  routing?: {                                                                             // RoutingConfig + remaps
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
    streaming?: { "keepalive-seconds"?: number; "bootstrap-retries"?: number; "send-keepalive-before-ft"?: boolean }; // StreamingConfig
    payload?: {                                                                           // PayloadConfig
      default?: CpaPayloadRule[]; "default-raw"?: CpaPayloadRule[];
      override?: CpaPayloadRule[]; "override-raw"?: CpaPayloadRule[]; filter?: CpaPayloadFilterRule[];
      replace?: CpaPayloadReplaceRule[];
    };
  };

  client?: {                                                                              // ClientConfig
    codex?: {
      "optimize-multi-agent-v2"?: boolean; "enable-apply-patch"?: boolean;
      "web-search-result-cache"?: { enabled?: boolean; ttl?: string | number; limit?: number } | null;
    };
    claude?: { "show-codex-commentary"?: boolean };
  };

  upstream?: {
    codex?: {                                                                             // CodexConfig (subset)
      "disable-codex-cloaking"?: boolean; "stream-bootstrap-buffering"?: boolean;
      "stream-bootstrap-timeout"?: string; "orphan-delegation-compatibility"?: boolean;
      "model-level-cooling"?: boolean; "response-steering"?: boolean;
      "upstream-request-compression"?: boolean; "upstream-request-compression-min-bytes"?: number;
      "websocket-compression"?: boolean;
    };
    claude?: {                                                                            // ClaudeConfig + ClaudeCodeConfig + remaps
      "model-level-cooling"?: boolean; "tool-search"?: boolean; "session-date-pin-days"?: number | null;
      "disable-claude-cloak-mode"?: boolean; "disable-cloaking-model-list"?: boolean;
      "header-defaults"?: CpaClaudeHeaderDefaults;
      /** Server-side model fallback; opt-in (off by default) since CPA v8.0.66. */
      "server-side-fallback"?: boolean;
    };
    xai?: { "inject-x-search"?: boolean };                                                // XAIConfig
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
        "live-media-relay"?: {                                                            // CodexLiveMediaRelayConfig
          enabled?: boolean; "max-sessions"?: number; "disable-private-remote-ips"?: boolean;
          "public-ip"?: string; "udp-port-min"?: number; "udp-port-max"?: number;
          "ice-servers"?: CpaICEServer[];
        };
        "signin-with-chatgpt-identifier"?: string;
        "header-defaults"?: { "user-agent"?: string; "beta-features"?: string };          // CodexHeaderDefaults
      };
      antigravity?: CpaSensitiveReplace & {                                               // AntigravityConfig + remaps
        "sensitive-words"?: string[];
        "connection-pool"?: CpaConnectionPool;
        /** Pool-wide pause after a TOS_VIOLATION; off by default. */
        "tos-pause-window"?: string;
        "antigravity-credits"?: boolean;
        "signature-cache-enabled"?: boolean; "signature-bypass-strict"?: boolean;
      };
      devin?: CpaSensitiveReplace & { "sensitive-words"?: string[] };
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

  plugins?: {                                                                             // PluginsConfig
    enabled?: boolean; dir?: string; "store-sources"?: string[]; "store-auth"?: CpaPluginStoreAuth[];
    /** read-only */ readonly "auth-revision"?: number;
    configs?: Record<string, CpaPluginInstanceConfig>;
  };

  "quota-exceeded"?: { "switch-project"?: boolean; "switch-preview-model"?: boolean };   // QuotaExceeded (antigravity-credits moved)
}

// Slash-separated paths into CpaConfig, for config.set / patchPath / getPath.
// Lists are not addressable (they are replaced whole), so paths stop at arrays.
type ConfigObject<T> = T extends readonly unknown[] ? never : T extends object ? T : never;

/** Every known path into {@link CpaConfig}, e.g. `'routing/retry'` or `'oauth/model-alias/claude'`. */
export type CpaConfigPath<T = CpaConfig> = {
  [K in keyof T & string]-?: K | (ConfigObject<NonNullable<T[K]>> extends never ? never : `${K}/${CpaConfigPath<ConfigObject<NonNullable<T[K]>>>}`);
}[keyof T & string];

/** Providers under `api-keys`, e.g. for building `['api-keys', provider]` paths from a variable. */
export type CpaApiKeyProvider = keyof NonNullable<CpaConfig['api-keys']>;

/** The value stored at a {@link CpaConfigPath}, e.g. `CpaConfigValue<'api-keys'>`. */
export type CpaConfigValue<P extends string, T = CpaConfig> = P extends `${infer K}/${infer Rest}`
  ? K extends keyof T
    ? CpaConfigValue<Rest, NonNullable<T[K]>>
    : never
  : P extends keyof T
    ? Exclude<T[P], undefined>
    : never;
