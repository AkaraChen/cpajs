import { CpaCredentialTokenError, CpaHttpError, CpaUpstreamError, parseApiCallBody } from '../errors.ts';
import type { ApiCallRequest, ApiCallResponse } from '../types/requests.ts';
import type { RequestOptions, Transport } from '../transport.ts';

const CREDENTIAL_TOKEN_ERRORS = new Set(['auth token not found', 'auth credential not found for auth_index', 'auth token refresh failed']);

function isCredentialTokenError(error: CpaHttpError): boolean {
  return error.status === 400 && error.errorCode !== undefined && CREDENTIAL_TOKEN_ERRORS.has(error.errorCode);
}

/** `/v8/management/requests/*`. */
export class RequestsResource {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /**
   * Makes an HTTP request from the server, optionally with a credential's
   * proxy and token (`$TOKEN$` in headers or `data`). Resolves whenever the
   * upstream call completed, whatever its status; check `status_code`.
   */
  async apiCall(request: ApiCallRequest, options: RequestOptions = {}): Promise<ApiCallResponse> {
    return (await this.#t.request<ApiCallResponse>({ ...options, method: 'POST', path: '/requests/api-call', json: request })).data;
  }

  /**
   * Like `apiCall`, but throws on failures and parses the upstream body.
   *
   * A non-2xx upstream status throws `CpaUpstreamError`; a CPA 400 caused by an
   * unresolvable `$TOKEN$` throws `CpaCredentialTokenError`. `data` is the JSON
   * body when it parses, the raw text otherwise, and `undefined` when empty.
   */
  async apiCallJson<T = unknown>(
    request: ApiCallRequest,
    options: RequestOptions = {},
  ): Promise<{ status: number; headers: Record<string, string[]>; data: T }> {
    let response: ApiCallResponse;
    try {
      response = await this.apiCall(request, options);
    } catch (error) {
      if (error instanceof CpaHttpError && isCredentialTokenError(error)) throw new CpaCredentialTokenError(error);
      throw error;
    }
    if (response.status_code < 200 || response.status_code >= 300) {
      throw new CpaUpstreamError({ method: request.method, url: request.url }, {
        status: response.status_code,
        headers: response.header,
        body: response.body,
      });
    }
    return { status: response.status_code, headers: response.header, data: parseApiCallBody(response.body) as T };
  }
}
