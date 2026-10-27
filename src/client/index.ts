import { ConfigResource } from './resources/config.ts';
import { CredentialsResource } from './resources/credentials.ts';
import { LogsResource } from './resources/logs.ts';
import { OAuthResource } from './resources/oauth.ts';
import { PluginsResource } from './resources/plugins.ts';
import { RequestsResource } from './resources/requests.ts';
import { RoutingResource } from './resources/routing.ts';
import { ServerResource } from './resources/server.ts';
import { UsageResource } from './resources/usage.ts';
import { Transport, type ClientOptions, type RawRequest, type TransportResponse } from './transport.ts';

export {
  CpaAbortError,
  CpaClientError,
  CpaCredentialTokenError,
  CpaHttpError,
  CpaNetworkError,
  CpaReconcileError,
  CpaResponseError,
  CpaTimeoutError,
  CpaUpstreamError,
} from './errors.ts';
export type { CpaReconcileErrorCode } from './errors.ts';
export type { ClientOptions, FetchLike, Query, QueryValue, RawRequest, RequestOptions, ResponseType, TransportResponse } from './transport.ts';
export type {
  ConfigMutationOptions,
  ConfigPath,
  ConfigPathValue,
  ConfigReconcileResult,
  ConfigUpdateResult,
  ConfigWriteOptions,
  ConfigWriteResult,
  JsonInput,
  Versioned,
} from './resources/config.ts';
export type {
  CredentialContent,
  CredentialFile,
  CredentialSelector,
  CredentialSummary,
  ModelsForOptions,
  ReconcileCredentialFile,
  ReconcileCredentialsInput,
  ReconcileCredentialsResult,
} from './resources/credentials.ts';
export type { DownloadedFile } from './resources/download.ts';
export type { WaitForOAuthOptions } from './resources/oauth.ts';
export {
  ConfigResource,
  CredentialsResource,
  LogsResource,
  OAuthResource,
  PluginsResource,
  RequestsResource,
  RoutingResource,
  ServerResource,
  UsageResource,
};
export type * from './types/index.ts';

/** Typed client for the CLIProxyAPI v8 management API (`/v8/management`). */
export class CpaClient {
  readonly #transport: Transport;
  readonly config: ConfigResource;
  readonly credentials: CredentialsResource;
  readonly oauth: OAuthResource;
  readonly logs: LogsResource;
  readonly usage: UsageResource;
  readonly routing: RoutingResource;
  readonly requests: RequestsResource;
  readonly plugins: PluginsResource;
  readonly server: ServerResource;

  constructor(options: ClientOptions) {
    this.#transport = new Transport(options);
    this.config = new ConfigResource(this.#transport);
    this.credentials = new CredentialsResource(this.#transport);
    this.oauth = new OAuthResource(this.#transport);
    this.logs = new LogsResource(this.#transport);
    this.usage = new UsageResource(this.#transport);
    this.routing = new RoutingResource(this.#transport);
    this.requests = new RequestsResource(this.#transport);
    this.plugins = new PluginsResource(this.#transport);
    this.server = new ServerResource(this.#transport);
  }

  /** Server root URL this client talks to. */
  get baseUrl(): URL {
    return this.#transport.baseUrl;
  }

  /**
   * OpenAI-compatible model API base URL (`<baseUrl>/v1`), for existing SDKs.
   * Authenticate those requests with a model API key from `access.api-keys`,
   * not with the management key.
   */
  get modelBaseUrl(): string {
    return modelApiBaseUrl(this.#transport.baseUrl);
  }

  /** Escape hatch for routes without a typed method. `path` is relative to `/v8/management`. */
  request<T = unknown>(request: RawRequest): Promise<TransportResponse<T>> {
    return this.#transport.request<T>(request);
  }
}

export function createClient(options: ClientOptions): CpaClient {
  return new CpaClient(options);
}

/** `<baseUrl>/v1`, keeping any path prefix. */
export function modelApiBaseUrl(baseUrl: string | URL): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
