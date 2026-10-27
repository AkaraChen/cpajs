import { CpaHttpError } from '../errors.ts';
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

export interface ConfigMutationOptions extends RequestOptions {
  /**
   * Read/write attempts before an optimistic-concurrency conflict is thrown.
   * A 412 re-reads the node and calls the update function again. Defaults to 5.
   */
  maxAttempts?: number | undefined;
}

export interface ConfigUpdateResult {
  /** `false` when the update function returned `undefined`, so nothing was written. */
  written: boolean;
  /** ETag of the write, or of the read when nothing was written. */
  etag: string | undefined;
}

export interface ConfigReconcileResult extends ConfigUpdateResult {
  /** Top-level keys whose stored value differed and were written. */
  changed: string[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copies the value without `auth_index`. GET injects it into API keys (and into
 * an `openai-compatibility` group without keys); writing it back is rejected.
 */
function withoutAuthIndex<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutAuthIndex(item)) as T;
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'auth_index') copy[key] = withoutAuthIndex(item);
  }
  return copy as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

function resolveMaxAttempts(options: ConfigMutationOptions): number {
  const value = options.maxAttempts ?? 5;
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`maxAttempts must be a positive integer, got ${value}`);
  return value;
}

function requestOptions(options: ConfigMutationOptions): RequestOptions {
  const { maxAttempts: _maxAttempts, ...rest } = options;
  return rest;
}

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
  readonly #locks = new Map<string, Promise<void>>();

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

  /** Reads a node, mapping a missing node (404) to `undefined`. */
  async #readOptional<T>(node: string, options: RequestOptions): Promise<Versioned<T> | undefined> {
    try {
      return await this.#read<T>(node, 'json', options);
    } catch (error) {
      if (error instanceof CpaHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Serialises tasks that touch the same path within this client instance. */
  #serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => {},
      () => {},
    );
    this.#locks.set(key, settled);
    void settled.then(() => {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    });
    return run;
  }

  async #update<P extends ConfigPath>(
    node: string,
    fn: (current: ConfigPathValue<P> | undefined) => ConfigPathValue<P> | undefined | Promise<ConfigPathValue<P> | undefined>,
    maxAttempts: number,
    options: RequestOptions,
  ): Promise<ConfigUpdateResult> {
    for (let attempt = 1; ; attempt++) {
      const read = await this.#readOptional<ConfigPathValue<P>>(node, options);
      const current = read === undefined ? undefined : withoutAuthIndex(read.data);
      const next = await fn(current);
      if (next === undefined) return { written: false, etag: read?.etag };
      try {
        const written = await this.#write('PUT', node, { json: next }, {
          ...options,
          ...(read?.etag === undefined ? {} : { ifMatch: read.etag }),
        });
        return { written: true, etag: written.etag };
      } catch (error) {
        if (attempt < maxAttempts && error instanceof CpaHttpError && error.status === 412) continue;
        throw error;
      }
    }
  }

  async #reconcile(partial: CpaConfig, maxAttempts: number, options: RequestOptions): Promise<ConfigReconcileResult> {
    const target = withoutAuthIndex(partial);
    for (let attempt = 1; ; attempt++) {
      const read = await this.#read<CpaConfig>('/config', 'json', options);
      const current = withoutAuthIndex(read.data);
      const changed = Object.keys(target).filter((key) => !deepEqual(current[key as keyof CpaConfig], target[key as keyof CpaConfig]));
      if (changed.length === 0) return { written: false, changed, etag: read.etag };
      const patch: Record<string, unknown> = {};
      for (const key of changed) patch[key] = target[key as keyof CpaConfig];
      try {
        const written = await this.#write('PATCH', '/config', { json: patch }, {
          ...options,
          ...(read.etag === undefined ? {} : { ifMatch: read.etag }),
        });
        return { written: true, changed, etag: written.etag };
      } catch (error) {
        if (attempt < maxAttempts && error instanceof CpaHttpError && error.status === 412) continue;
        throw error;
      }
    }
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

  /**
   * Reads a node, passes it to `fn`, and writes the result back with `If-Match`.
   * A missing node (404) passes `undefined`. Returning `undefined` writes
   * nothing. A 412 re-reads and calls `fn` again, up to `maxAttempts` times.
   *
   * The value handed to `fn` has the read-only `auth_index` fields removed
   * (GET injects them into API keys), so it is safe to write back.
   * Calls for the same path on one client instance run one at a time.
   */
  update<P extends ConfigPath>(
    path: P,
    fn: (current: ConfigPathValue<P> | undefined) => ConfigPathValue<P> | undefined | Promise<ConfigPathValue<P> | undefined>,
    options: ConfigMutationOptions = {},
  ): Promise<ConfigUpdateResult> {
    const node = nodePath(path);
    return this.#serialize(node, () => this.#update<P>(node, fn, resolveMaxAttempts(options), requestOptions(options)));
  }

  /**
   * Writes only the top-level sections in `partial` whose stored value differs,
   * after a deep comparison that ignores the injected `auth_index` fields.
   * Sections are written with PATCH semantics (objects merge, arrays and scalars
   * replace) and share one `If-Match`; a 412 re-reads and retries.
   */
  reconcile(partial: CpaConfig, options: ConfigMutationOptions = {}): Promise<ConfigReconcileResult> {
    return this.#serialize('/config', () => this.#reconcile(partial, resolveMaxAttempts(options), requestOptions(options)));
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
