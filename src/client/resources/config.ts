import type { JsonValue } from '../types/common.ts';
import type { CpaConfig, CpaConfigPath, CpaConfigValue } from '../types/config.ts';
import { encodePath, type RequestOptions, type Transport } from '../transport.ts';

/** A value together with the ETag of the config file it was read from or written to. */
export interface Versioned<T> {
  data: T;
  /** Strong ETag of the on-disk file. Pass it as `ifMatch` for optimistic concurrency. */
  etag: string | undefined;
}

export interface ConfigWriteOptions extends RequestOptions {
  /**
   * Only write if the file still has this ETag (or `*`). A mismatch fails with
   * a 412 `CpaHttpError` (`errorCode === 'precondition_failed'`).
   *
   * Writing a plaintext `management.secret-key` makes CPA rewrite the file
   * with a bcrypt hash a few seconds later, so read again before the next
   * conditional write.
   */
  ifMatch?: string | undefined;
}

export interface ConfigWriteResult {
  status: 'ok';
  'config-version': 8;
}

/**
 * A config path: `'routing/retry'` or `['routing', 'retry']`. Segments are
 * dash-case YAML keys; list indices are not addressable (lists are replaced whole).
 */
export type ConfigPath = string | readonly string[];

/**
 * The value accepted at `P`: the {@link CpaConfig} type for a known string path,
 * any JSON-serialisable value otherwise (array paths, plugin options, computed strings).
 */
export type ConfigPathValue<P extends ConfigPath> = P extends CpaConfigPath ? CpaConfigValue<P> : JsonInput;

/** JSON-serialisable input. Unlike {@link JsonValue} it accepts interfaces such as `CpaConfig['routing']`. */
export type JsonInput = string | number | boolean | null | object;

function withIfMatch(options: ConfigWriteOptions): RequestOptions {
  const { ifMatch, ...rest } = options;
  if (ifMatch === undefined) return rest;
  const headers = new Headers(rest.headers);
  headers.set('If-Match', ifMatch);
  return { ...rest, headers };
}

function nodePath(path: ConfigPath): string {
  const encoded = encodePath(path, 'config path');
  if (encoded === '') throw new TypeError('config path must not be empty; use the whole-document methods instead.');
  return `/config/${encoded}`;
}

/** `/v8/management/config*`: the native configuration document. */
export class ConfigResource {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  async #read<T>(path: string, responseType: 'json' | 'text', options: RequestOptions): Promise<Versioned<T>> {
    const res = await this.#t.request<T>({ ...options, method: 'GET', path, responseType });
    return { data: res.data, etag: res.headers.get('ETag') ?? undefined };
  }

  async #write(method: string, path: string, body: { json: unknown } | { yaml: string } | undefined, options: ConfigWriteOptions) {
    const res = await this.#t.request<ConfigWriteResult>({
      ...withIfMatch(options),
      method,
      path,
      ...(body === undefined ? {} : 'json' in body ? { json: body.json } : { body: body.yaml, contentType: 'application/yaml' }),
    });
    return { data: res.data, etag: res.headers.get('ETag') ?? undefined } satisfies Versioned<ConfigWriteResult>;
  }

  /**
   * The whole config as JSON, migrated to v8 in memory. TURN `username` and
   * `credential` are removed and `auth_index` is added to API keys; writing it
   * back is still safe. Use {@link getYaml} for a lossless copy.
   */
  get(options: RequestOptions = {}): Promise<Versioned<CpaConfig>> {
    return this.#read('/config', 'json', options);
  }

  /** Replaces the whole document. Omitted sections are deleted. */
  replace(config: CpaConfig, options: ConfigWriteOptions = {}): Promise<Versioned<ConfigWriteResult>> {
    return this.#write('PUT', '/config', { json: config }, options);
  }

  /**
   * Deep-merges into the document. Objects merge key by key; arrays and
   * scalars replace. `null` is stored as null, it does not delete — use
   * {@link delete} to remove a key.
   */
  patch(partial: CpaConfig, options: ConfigWriteOptions = {}): Promise<Versioned<ConfigWriteResult>> {
    return this.#write('PATCH', '/config', { json: partial }, options);
  }

  /** The config file as YAML, with comments and without redaction. */
  getYaml(options: RequestOptions = {}): Promise<Versioned<string>> {
    return this.#read('/config.yaml', 'text', options);
  }

  /** Replaces the whole document with YAML (JSON is accepted too). */
  replaceYaml(yaml: string, options: ConfigWriteOptions = {}): Promise<Versioned<ConfigWriteResult>> {
    return this.#write('PUT', '/config.yaml', { yaml }, options);
  }

  /** Reads one node, e.g. `getPath('server/port')`. A missing node is a 404 `CpaHttpError`. */
  getPath<T = JsonValue>(path: ConfigPath, options: RequestOptions = {}): Promise<Versioned<T>> {
    return this.#read(nodePath(path), 'json', options);
  }

  /** Replaces or creates one node. Missing parent objects are created. */
  set<P extends ConfigPath>(path: P, value: ConfigPathValue<P>, options: ConfigWriteOptions = {}): Promise<Versioned<ConfigWriteResult>> {
    return this.#write('PUT', nodePath(path), { json: value }, options);
  }

  /** Deep-merges into one node (see {@link patch}). */
  patchPath<P extends ConfigPath>(path: P, value: ConfigPathValue<P>, options: ConfigWriteOptions = {}): Promise<Versioned<ConfigWriteResult>> {
    return this.#write('PATCH', nodePath(path), { json: value }, options);
  }

  /** Removes one node and any parents left empty. A missing node is a 404 `CpaHttpError`. */
  delete(path: ConfigPath, options: ConfigWriteOptions = {}): Promise<Versioned<ConfigWriteResult>> {
    return this.#write('DELETE', nodePath(path), undefined, options);
  }
}
