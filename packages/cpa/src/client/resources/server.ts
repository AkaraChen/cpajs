import { CpaHttpError } from '../errors.ts';
import type { HealthzResponse, LatestVersionResponse, ServerInfo } from '../types/server.ts';
import type { RequestOptions, Transport } from '../transport.ts';

function readInfo(headers: Headers): ServerInfo | undefined {
  const version = headers.get('X-CPA-VERSION');
  if (version === null) return undefined;
  return {
    version,
    commit: headers.get('X-CPA-COMMIT') ?? '',
    buildDate: headers.get('X-CPA-BUILD-DATE') ?? '',
    supportPlugin: headers.get('X-CPA-SUPPORT-PLUGIN') === '1',
  };
}

/** Server information: `/healthz`, version headers and `/v8/management/server/*`. */
export class ServerResource {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** `GET /healthz` (no management key needed). */
  async health(options: RequestOptions = {}): Promise<HealthzResponse> {
    return (await this.#t.request<HealthzResponse>({ ...options, method: 'GET', path: '/healthz', root: true, anonymous: true })).data;
  }

  /**
   * Version, commit, build date and plugin support of the running server,
   * read from the `X-CPA-*` headers of a cheap authenticated request.
   */
  async info(options: RequestOptions = {}): Promise<ServerInfo> {
    let headers: Headers;
    try {
      headers = (await this.#t.request<unknown>({ ...options, method: 'GET', path: '/config/config-version' })).headers;
    } catch (error) {
      // A config without `config-version` answers 404, which still carries the headers.
      if (!(error instanceof CpaHttpError) || error.status !== 404) throw error;
      headers = error.headers;
    }
    const info = readInfo(headers);
    if (!info) throw new TypeError('The server did not send X-CPA-VERSION; is management enabled?');
    return info;
  }

  /** Latest CLIProxyAPI release tag on GitHub (e.g. `"v8.0.43"`), fetched by the server. */
  async latestVersion(options: RequestOptions = {}): Promise<string> {
    const res = await this.#t.request<LatestVersionResponse>({ ...options, method: 'GET', path: '/server/latest-version' });
    return res.data['latest-version'];
  }
}
