import type { ApiKeyUsageResponse, UsageQueueResponse } from '../types/observability.ts';
import type { RequestOptions, Transport } from '../transport.ts';

/** `/v8/management/observability/usage/*`. */
export class UsageResource {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** Request counters per config API key. Map keys are `"<base-url>|<api-key>"` with the raw key. */
  async apiKeys(options: RequestOptions = {}): Promise<ApiKeyUsageResponse> {
    return (await this.#t.request<ApiKeyUsageResponse>({ ...options, method: 'GET', path: '/observability/usage/api-keys' })).data;
  }

  /**
   * Removes and returns up to `count` (default 1) of the oldest queued usage
   * records. Destructive: concurrent consumers split the records between them.
   * Records are only queued while `observability.usage.usage-statistics-enabled` is on.
   */
  async popQueue(count?: number, options: RequestOptions = {}): Promise<UsageQueueResponse> {
    return (
      await this.#t.request<UsageQueueResponse>({ ...options, method: 'GET', path: '/observability/usage/queue', query: { count } })
    ).data;
  }
}
