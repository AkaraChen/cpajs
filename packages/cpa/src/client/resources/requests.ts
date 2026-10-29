import type { ApiCallRequest, ApiCallResponse } from '../types/requests.ts';
import type { RequestOptions, Transport } from '../transport.ts';

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
}
