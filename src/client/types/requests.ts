// Types for /v8/management/requests.
// Derived from CLIProxyAPI v8.0.43; see docs/api-coverage.md.

// ---------- requests/api-call ----------
export interface ApiCallRequest {
  auth_index?: string;   // also accepted: authIndex, AuthIndex
  authIndex?: string;
  AuthIndex?: string;
  method: string;        // required
  url: string;           // required, absolute
  proxy_url?: string;    // http(s)://, socks5://, socks5h://, "direct", "none"
  header?: Record<string, string>; // "$TOKEN$" substituted; "Host" overrides req.Host
  data?: string;         // raw body; "$TOKEN$" substituted
}
export interface ApiCallResponse {
  status_code: number;
  header: Record<string, string[]>;
  body: string;
}
