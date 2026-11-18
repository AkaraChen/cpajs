import type { CooldownResetResponse, ModelCatalogRefreshResponse, ModelDefinitionsResponse, StaticModelChannel } from '../types/routing.ts';
import type { RequestOptions, Transport } from '../transport.ts';

/** `/v8/management/routing/*`. */
export class RoutingResource {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** Clears quota and cooldown state for one credential. */
  async resetCooldown(authIndex: string, options: RequestOptions = {}): Promise<CooldownResetResponse> {
    return (
      await this.#t.request<CooldownResetResponse>({ ...options, method: 'POST', path: '/routing/cooldown/reset', json: { auth_index: authIndex } })
    ).data;
  }

  /** Built-in model definitions for a channel (or a plugin provider). */
  async modelDefinitions(channel: StaticModelChannel | (string & {}), options: RequestOptions = {}): Promise<ModelDefinitionsResponse> {
    return (
      await this.#t.request<ModelDefinitionsResponse>({
        ...options,
        method: 'GET',
        path: `/routing/model-definitions/${encodeURIComponent(channel)}`,
      })
    ).data;
  }

  /**
   * Refreshes the model catalogs (`models.catalog`, `codex-catalog`,
   * `devin-catalog`) from their sources now. Embedded or disabled catalogs are
   * skipped. A failed fetch rejects with a `CpaHttpError` (502) whose `data` is
   * a `ModelCatalogRefreshFailure`. CPA also serves this as `POST /models/refresh`.
   */
  async refreshModelDefinitions(options: RequestOptions = {}): Promise<ModelCatalogRefreshResponse> {
    return (await this.#t.request<ModelCatalogRefreshResponse>({ ...options, method: 'POST', path: '/routing/model-definitions/refresh' })).data;
  }
}
