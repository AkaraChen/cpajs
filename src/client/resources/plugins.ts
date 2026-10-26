import type {
  DeletePluginResponse,
  PluginInstallQuery,
  PluginInstallResponse,
  PluginListResponse,
  PluginQuotaResetResponse,
  PluginStoreListResponse,
  QuotaFetchResponse,
} from '../types/plugins.ts';
import type { RequestOptions, Transport } from '../transport.ts';

/** `/v8/management/plugins*`. */
export class PluginsResource {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  async list(options: RequestOptions = {}): Promise<PluginListResponse> {
    return (await this.#t.request<PluginListResponse>({ ...options, method: 'GET', path: '/plugins' })).data;
  }

  /** Deletes the plugin file and its `plugins.configs` entry. */
  async delete(id: string, options: RequestOptions = {}): Promise<DeletePluginResponse> {
    return (await this.#t.request<DeletePluginResponse>({ ...options, method: 'DELETE', path: `/plugins/${encodeURIComponent(id)}` })).data;
  }

  /** Lists plugins from every store source (network access on the server). */
  async store(options: RequestOptions = {}): Promise<PluginStoreListResponse> {
    return (await this.#t.request<PluginStoreListResponse>({ ...options, method: 'GET', path: '/plugins/store' })).data;
  }

  /**
   * Installs a store plugin by plugin id (not `store_id`) and enables it.
   * The global `plugins.enabled` switch is left unchanged.
   */
  async install(id: string, query: PluginInstallQuery = {}, options: RequestOptions = {}): Promise<PluginInstallResponse> {
    return (
      await this.#t.request<PluginInstallResponse>({
        ...options,
        method: 'POST',
        path: `/plugins/store/${encodeURIComponent(id)}/install`,
        query: { ...query },
      })
    ).data;
  }

  /**
   * Fetches quota for a credential from the plugin's quota provider.
   * (`POST /plugins/:id/quota` runs the same handler and is not exposed separately.)
   */
  async quota(id: string, authIndex: string, options: RequestOptions = {}): Promise<QuotaFetchResponse> {
    return (
      await this.#t.request<QuotaFetchResponse>({ ...options, method: 'GET', path: `/plugins/${encodeURIComponent(id)}/quota`, query: { auth_index: authIndex } })
    ).data;
  }

  /** Resets plugin quota state for a credential, then its routing cooldown. */
  async resetQuota(id: string, authIndex: string, options: RequestOptions = {}): Promise<PluginQuotaResetResponse> {
    return (
      await this.#t.request<PluginQuotaResetResponse>({
        ...options,
        method: 'DELETE',
        path: `/plugins/${encodeURIComponent(id)}/quota`,
        query: { auth_index: authIndex },
      })
    ).data;
  }
}
