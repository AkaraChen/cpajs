// Types for /healthz and /v8/management/server.
// Derived from CLIProxyAPI v8.0.43; see docs/api-coverage.md.

// ---------- /healthz ----------
export interface HealthzResponse { status: "ok" }

// ---------- server/latest-version ----------
export interface LatestVersionResponse { "latest-version": string } // raw GitHub tag, e.g. "v8.0.43"
export type LatestVersionErrorCode =
  | "request_create_failed" | "request_failed" | "unexpected_status" | "decode_failed" | "invalid_response";

/** Response headers set by the management auth middleware (handler.go:325-328). */
export interface ServerInfo {
  version: string;        // X-CPA-VERSION (e.g. "8.0.43"; "dev" for unversioned builds)
  commit: string;         // X-CPA-COMMIT
  buildDate: string;      // X-CPA-BUILD-DATE ("unknown" when not stamped)
  supportPlugin: boolean; // X-CPA-SUPPORT-PLUGIN === "1"
}
