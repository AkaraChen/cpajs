import type { DeleteLogsResponse, GetLogsQuery, GetLogsResponse, RequestErrorLogsResponse } from '../types/observability.ts';
import type { RequestOptions, Transport } from '../transport.ts';
import { attachmentFilename, type DownloadedFile } from './download.ts';

/** `/v8/management/observability/logs*`. */
export class LogsResource {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /**
   * Reads the main log. Requires `observability.logs.logging-to-file`.
   * For incremental reads pass the previous `next-cursor` as `cursor`; when
   * the response has `cursor-reset: true`, replace what you have instead of appending.
   */
  async get(query: GetLogsQuery = {}, options: RequestOptions = {}): Promise<GetLogsResponse> {
    return (await this.#t.request<GetLogsResponse>({ ...options, method: 'GET', path: '/observability/logs', query: { ...query } })).data;
  }

  /** Truncates the main log and removes rotated main log files. */
  async clear(options: RequestOptions = {}): Promise<DeleteLogsResponse> {
    return (await this.#t.request<DeleteLogsResponse>({ ...options, method: 'DELETE', path: '/observability/logs' })).data;
  }

  /** Lists `error-*.log` request error files, newest first. */
  async listErrorLogs(options: RequestOptions = {}): Promise<RequestErrorLogsResponse> {
    return (await this.#t.request<RequestErrorLogsResponse>({ ...options, method: 'GET', path: '/observability/logs/errors' })).data;
  }

  /** Downloads one request error log by file name. */
  async downloadErrorLog(name: string, options: RequestOptions = {}): Promise<DownloadedFile> {
    return this.#download(`/observability/logs/errors/${encodeURIComponent(name)}`, options);
  }

  /** Downloads the request log for a request ID (CPA matches on its last 8 characters). */
  async downloadRequestLog(requestId: string, options: RequestOptions = {}): Promise<DownloadedFile> {
    return this.#download(`/observability/logs/requests/${encodeURIComponent(requestId)}`, options);
  }

  async #download(path: string, options: RequestOptions): Promise<DownloadedFile> {
    const res = await this.#t.request<Blob>({ ...options, method: 'GET', path, responseType: 'blob' });
    return { filename: attachmentFilename(res.headers), blob: res.data };
  }
}
