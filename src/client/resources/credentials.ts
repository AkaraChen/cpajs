import type {
  AuthFileEntry,
  CoreAuth,
  CredentialModelsResponse,
  DeleteCredentialsResponse,
  ForceRefreshResult,
  ListCredentialsQuery,
  ListCredentialsResponse,
  PatchCredentialFieldsRequest,
  PatchCredentialFieldsResponse,
  PatchCredentialStatusRequest,
  PatchCredentialStatusResponse,
  SIWCStatusResponse,
  UploadCredentialsResponse,
} from '../types/credentials.ts';
import type { RequestOptions, Transport } from '../transport.ts';

/** Credential file content: a parsed JSON object, JSON text, or raw bytes. */
export type CredentialContent = Record<string, unknown> | string | Blob | Uint8Array<ArrayBuffer> | ArrayBuffer;

export interface CredentialFile {
  /** File name in the auth directory; must end with `.json`. */
  name: string;
  content: CredentialContent;
}

/** Identifies a credential by auth ID / file name or by `auth_index`. */
export type CredentialSelector = { name: string; auth_index?: string } | { auth_index: string; name?: string };

function toBlob(content: CredentialContent): Blob {
  if (content instanceof Blob) return content;
  if (typeof content === 'string') return new Blob([content], { type: 'application/json' });
  if (content instanceof ArrayBuffer || content instanceof Uint8Array) return new Blob([content], { type: 'application/json' });
  return new Blob([JSON.stringify(content)], { type: 'application/json' });
}

/** `/v8/management/credentials*`: OAuth and API-key credential files. */
export class CredentialsResource {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** Lists credentials. Passing `page` or `page_size` enables pagination fields in the response. */
  async list(query: ListCredentialsQuery = {}, options: RequestOptions = {}): Promise<ListCredentialsResponse> {
    return (await this.#t.request<ListCredentialsResponse>({ ...options, method: 'GET', path: '/credentials', query: { ...query } })).data;
  }

  /** Finds one credential by auth ID / file name, or returns undefined. */
  async get(name: string, options: RequestOptions = {}): Promise<AuthFileEntry | undefined> {
    const { files } = await this.list({ name }, options);
    return files[0];
  }

  /** Uploads (or overwrites) one credential file. */
  async upload(file: CredentialFile, options: RequestOptions = {}): Promise<UploadCredentialsResponse> {
    const res = await this.#t.request<UploadCredentialsResponse>({
      ...options,
      method: 'POST',
      path: '/credentials',
      query: { name: file.name },
      body: toBlob(file.content),
      contentType: 'application/json',
    });
    return res.data;
  }

  /**
   * Uploads several credential files in one multipart request. When some
   * files fail the server answers 207 and this resolves with `status: 'partial'`.
   */
  async uploadMany(files: readonly CredentialFile[], options: RequestOptions = {}): Promise<UploadCredentialsResponse> {
    if (files.length === 0) throw new TypeError('uploadMany needs at least one file.');
    const form = new FormData();
    for (const file of files) form.append('file', toBlob(file.content), file.name);
    return (await this.#t.request<UploadCredentialsResponse>({ ...options, method: 'POST', path: '/credentials', body: form })).data;
  }

  /** Deletes credentials by auth ID or file name. Partial failures resolve with `status: 'partial'`. */
  async delete(names: string | readonly string[], options: RequestOptions = {}): Promise<DeleteCredentialsResponse> {
    const list = typeof names === 'string' ? [names] : [...names];
    if (list.length === 0) throw new TypeError('delete needs at least one name.');
    return (await this.#t.request<DeleteCredentialsResponse>({ ...options, method: 'DELETE', path: '/credentials', query: { name: list } }))
      .data;
  }

  /** Deletes every `*.json` file in the auth directory. */
  async deleteAll(options: RequestOptions = {}): Promise<{ status: 'ok'; deleted: number }> {
    return (await this.#t.request<{ status: 'ok'; deleted: number }>({ ...options, method: 'DELETE', path: '/credentials', query: { all: 'true' } }))
      .data;
  }

  /** Models available through one credential. */
  async models(name: string, options: RequestOptions = {}): Promise<CredentialModelsResponse> {
    return (await this.#t.request<CredentialModelsResponse>({ ...options, method: 'GET', path: '/credentials/models', query: { name } })).data;
  }

  /** Downloads a credential file by file name. The content includes tokens. */
  async download(name: string, options: RequestOptions = {}): Promise<Blob> {
    return (await this.#t.request<Blob>({ ...options, method: 'GET', path: '/credentials/download', query: { name }, responseType: 'blob' })).data;
  }

  /** Enables or disables a credential. */
  async setStatus(request: PatchCredentialStatusRequest, options: RequestOptions = {}): Promise<PatchCredentialStatusResponse> {
    return (await this.#t.request<PatchCredentialStatusResponse>({ ...options, method: 'PATCH', path: '/credentials/status', json: request })).data;
  }

  /**
   * Sets metadata fields on a credential file. Keys may be dotted paths;
   * `headers` is merged and an empty string removes a header.
   */
  async patchFields(request: PatchCredentialFieldsRequest, options: RequestOptions = {}): Promise<PatchCredentialFieldsResponse> {
    return (await this.#t.request<PatchCredentialFieldsResponse>({ ...options, method: 'PATCH', path: '/credentials/fields', json: request })).data;
  }

  /** Forces a token refresh for one credential. The returned auth record contains raw tokens. */
  async refresh(selector: CredentialSelector, options: RequestOptions = {}): Promise<{ ok: true; auth: CoreAuth }> {
    return (await this.#t.request<{ ok: true; auth: CoreAuth }>({ ...options, method: 'POST', path: '/credentials/refresh', json: selector })).data;
  }

  /** Forces a token refresh for every enabled credential that supports it. */
  async refreshAll(options: RequestOptions = {}): Promise<{ ok: true; results: ForceRefreshResult[] }> {
    return (
      await this.#t.request<{ ok: true; results: ForceRefreshResult[] }>({ ...options, method: 'POST', path: '/credentials/refresh', json: { all: true } })
    ).data;
  }

  /** Sign in with ChatGPT binding state of a Codex credential. */
  async siwcStatus(selector: CredentialSelector, options: RequestOptions = {}): Promise<SIWCStatusResponse> {
    return (await this.#t.request<SIWCStatusResponse>({ ...options, method: 'GET', path: '/credentials/siwc/status', query: { ...selector } })).data;
  }
}
