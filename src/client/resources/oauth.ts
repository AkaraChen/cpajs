import type {
  CancelOAuthSessionResponse,
  OAuthAuthUrlRequest,
  OAuthAuthUrlResponse,
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  OAuthStatusResponse,
  SIWCBindResponse,
  VertexImportResponse,
} from '../types/oauth.ts';
import type { SIWCStatusResponse } from '../types/credentials.ts';
import type { RequestOptions, Transport } from '../transport.ts';
import type { CredentialContent, CredentialSelector } from './credentials.ts';

export interface WaitForOAuthOptions extends RequestOptions {
  /** Poll interval. Default 2 000 ms. */
  intervalMs?: number;
}

/** `/v8/management/oauth/*`: native login flows. */
export class OAuthResource {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /**
   * Starts a login and returns the URL to open. Device flows (xai, meta, kimi)
   * also return `user_code`. Poll {@link status} with the returned `state`.
   */
  async start(request: OAuthAuthUrlRequest, options: RequestOptions = {}): Promise<OAuthAuthUrlResponse> {
    return (await this.#t.request<OAuthAuthUrlResponse>({ ...options, method: 'POST', path: '/oauth/auth-url', json: request })).data;
  }

  /** Session state: `wait` while pending, `ok` when done, `error` with a message otherwise. */
  async status(state: string, options: RequestOptions = {}): Promise<OAuthStatusResponse> {
    return (await this.#t.request<OAuthStatusResponse>({ ...options, method: 'GET', path: '/oauth/status', query: { state } })).data;
  }

  /** Polls {@link status} until the session leaves `wait`. Abort with `signal`. */
  async waitForCompletion(state: string, options: WaitForOAuthOptions = {}): Promise<Exclude<OAuthStatusResponse, { status: 'wait' }>> {
    const { intervalMs = 2_000, ...requestOptions } = options;
    while (true) {
      const result = await this.status(state, requestOptions);
      if (result.status !== 'wait') return result;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, intervalMs);
        requestOptions.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(requestOptions.signal!.reason);
          },
          { once: true },
        );
      });
    }
  }

  /** Cancels a pending session. `cancelled` is false if it was unknown or already finished. */
  async cancel(state: string, options: RequestOptions = {}): Promise<CancelOAuthSessionResponse> {
    return (await this.#t.request<CancelOAuthSessionResponse>({ ...options, method: 'DELETE', path: '/oauth/session', query: { state } })).data;
  }

  /**
   * Completes a browser flow by handing over the final redirect URL (or
   * `state` + `code`). Useful when the provider's loopback callback cannot
   * reach the server. This route does not require the management key.
   */
  async callback(request: OAuthCallbackRequest, options: RequestOptions = {}): Promise<OAuthCallbackResponse> {
    return (await this.#t.request<OAuthCallbackResponse>({ ...options, method: 'POST', path: '/oauth/callback', json: request, anonymous: true }))
      .data;
  }

  /** Imports a Google Cloud service account key as a Vertex credential. */
  async importVertex(
    input: { serviceAccount: CredentialContent; location?: string; fileName?: string },
    options: RequestOptions = {},
  ): Promise<VertexImportResponse> {
    const form = new FormData();
    const content = input.serviceAccount;
    const blob =
      content instanceof Blob
        ? content
        : new Blob([typeof content === 'string' || content instanceof ArrayBuffer || content instanceof Uint8Array ? content : JSON.stringify(content)], {
            type: 'application/json',
          });
    form.append('file', blob, input.fileName ?? 'service-account.json');
    if (input.location !== undefined) form.append('location', input.location);
    return (
      await this.#t.request<VertexImportResponse>({ ...options, method: 'POST', path: '/oauth/import', query: { provider: 'vertex' }, body: form })
    ).data;
  }

  /** Starts binding Sign in with ChatGPT to a file-backed Codex OAuth credential. */
  async siwcBind(name: string, options: RequestOptions = {}): Promise<SIWCBindResponse> {
    return (await this.#t.request<SIWCBindResponse>({ ...options, method: 'POST', path: '/oauth/siwc/bind', json: { name } })).data;
  }

  /** Same as `credentials.siwcStatus`, via the oauth route. */
  async siwcStatus(selector: CredentialSelector, options: RequestOptions = {}): Promise<SIWCStatusResponse> {
    return (await this.#t.request<SIWCStatusResponse>({ ...options, method: 'GET', path: '/oauth/siwc/status', query: { ...selector } })).data;
  }
}
