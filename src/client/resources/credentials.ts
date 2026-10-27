import { CpaCredentialNotFoundError, CpaReconcileError, type CpaCredentialNotFoundSelector } from '../errors.ts';
import { ConfigResource } from './config.ts';
import type {
  CpaClaudeKey,
  CpaClaudeModel,
  CpaCodexKey,
  CpaCodexModel,
  CpaConfig,
  CpaGeminiKey,
  CpaGeminiModel,
  CpaKeyGroup,
  CpaModelBase,
  CpaOpenAICompatGroup,
  CpaOpenAICompatKey,
  CpaOpenAICompatModel,
  CpaThinkingSupport,
  CpaVertexKey,
  CpaVertexModel,
} from '../types/config.ts';
import type {
  AuthFileEntry,
  CoreAuth,
  CredentialModel,
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
import type { ModelDefinitionsResponse, ModelInfo, ThinkingSupport } from '../types/routing.ts';
import { managementUrl, type RequestOptions, type Transport } from '../transport.ts';

/** Credential file content: a parsed JSON object, JSON text, or raw bytes. */
export type CredentialContent = Record<string, unknown> | string | Blob | Uint8Array<ArrayBuffer> | ArrayBuffer;

export interface CredentialFile {
  /** File name in the auth directory; must end with `.json`. */
  name: string;
  content: CredentialContent;
}

/** One file in a reconcile set. */
export interface ReconcileCredentialFile {
  /** File name in the auth directory; must end with `.json`. */
  name: string;
  /** A parsed JSON object, JSON text, or raw bytes; must resolve to a JSON object. */
  content: CredentialContent;
  /** Opaque version. An unchanged revision leaves the file alone. */
  revision: string;
}

/** A claimed file's revision plus legacy top-level fields to drop before writing the marker. */
export interface ReconcileAdoption {
  /** Revision to record in `x-cpajs`; compared with the desired file's revision. */
  revision: string;
  /**
   * Top-level fields to delete from the kept content before `x-cpajs` is written.
   * Removing `x-cpajs` itself is ignored: reconcile always stamps its own marker.
   */
  remove?: readonly string[];
}

/** What `adopt` may return: a revision string, a revision with removals, or `undefined`. */
export type ReconcileAdoptionResult = string | ReconcileAdoption;

export interface ReconcileCredentialsInput {
  /** Only files carrying this owner in `x-cpajs` are managed; others are never touched. */
  owner: string;
  files: readonly ReconcileCredentialFile[];
  /** Delete files owned by `owner` that are not in `files`. Defaults to true. */
  prune?: boolean;
  /**
   * Claims files without an `x-cpajs` marker. Return a revision to keep the
   * file's existing content (tokens included) and add `x-cpajs: { owner, revision }`,
   * or `undefined` to leave it unmanaged. Return `{ revision, remove }` to drop
   * legacy top-level fields such as `chat_seed` from the kept content first;
   * `remove` cannot delete the `x-cpajs` marker. Without this, an unmarked file
   * with the same name makes reconcile throw instead of overwriting it.
   */
  adopt?: (
    name: string,
    body: Record<string, unknown>,
  ) => ReconcileAdoptionResult | undefined | Promise<ReconcileAdoptionResult | undefined>;
}

export interface ReconcileCredentialsResult {
  uploaded: string[];
  deleted: string[];
  unchanged: string[];
  /** Files claimed through `adopt`; an adopted file is also `uploaded` or `unchanged`. */
  adopted: string[];
}

/** Identifies a credential by auth ID / file name or by `auth_index`. */
export type CredentialSelector = { name: string; auth_index?: string } | { auth_index: string; name?: string };

/** A status change for a file (by `name`) or a config key (by `auth_index`). */
export type SetCredentialStatusRequest = PatchCredentialStatusRequest | { auth_index: string; name?: string; disabled: boolean };

/** A delete target: file name(s), or one credential by `auth_index` (a config key or a file). */
export type CredentialDeleteTarget = string | readonly string[] | { auth_index: string };

type GroupWithoutKeys<G extends { keys?: unknown }> = Omit<G, 'keys'>;

/** A config API key's group with `keys` removed. */
export type ConfigCredentialGroup =
  | GroupWithoutKeys<CpaKeyGroup<CpaGeminiKey, CpaGeminiModel>>
  | GroupWithoutKeys<CpaKeyGroup<CpaVertexKey, CpaVertexModel>>
  | GroupWithoutKeys<CpaKeyGroup<CpaCodexKey, CpaCodexModel>>
  | GroupWithoutKeys<CpaKeyGroup<CpaClaudeKey, CpaClaudeModel>>
  | GroupWithoutKeys<CpaOpenAICompatGroup>;

/**
 * The raw config entry behind a config credential: a provider-specific API key,
 * or an OpenAI-compatible group when it has no keys of its own.
 */
export type ConfigCredentialRaw = CpaGeminiKey | CpaVertexKey | CpaCodexKey | CpaClaudeKey | CpaOpenAICompatKey | CpaOpenAICompatGroup;

/** A credential file, as returned by {@link CredentialsResource.listAll}. */
export interface FileCredentialSummary {
  /** Runtime auth index. Empty when CPA does not expose one. */
  auth_index: string;
  provider: string;
  source: 'file';
  /** File name. */
  name: string;
  disabled: boolean;
  raw: AuthFileEntry;
}

/** One config `api-keys` entry, as returned by {@link CredentialsResource.listAll}. */
export interface ConfigCredentialSummary {
  /** Runtime auth index. Empty when CPA does not expose one (e.g. an invalid config key). */
  auth_index: string;
  provider: string;
  source: 'config';
  /** Config group name. */
  label?: string;
  disabled: boolean;
  /**
   * This entry's API key in plaintext: the key of a native provider key or of an
   * OpenAI-compatible key entry. Absent when the entry has no `api-key`, including
   * a keyless OpenAI-compatible group (which is itself the credential).
   */
  apiKey?: string;
  raw: ConfigCredentialRaw;
  /** The enclosing group, without its `keys`. */
  group: ConfigCredentialGroup;
}

/** One credential file or one config API key, as returned by {@link CredentialsResource.listAll}. */
export type CredentialSummary = FileCredentialSummary | ConfigCredentialSummary;

export interface ModelsForOptions extends RequestOptions {
  /**
   * Merge the channel's `model-definitions` into each model, so the result carries
   * context limits, thinking support and the other static metadata.
   */
  details?: boolean;
  /** Fetch the channel's model definitions again instead of using the client's cache. */
  refreshDefinitions?: boolean;
}

type ConfiguredModel = (CpaModelBase | CpaOpenAICompatModel) & { 'max-context-length'?: number };

interface ConfigCredential {
  summary: ConfigCredentialSummary;
  provider: string;
  channel: string | undefined;
  models: readonly ConfiguredModel[] | undefined;
  excluded: readonly string[] | undefined;
  openaiCompat: boolean;
  /** Index of the group in `api-keys.<provider>`. */
  groupIndex: number;
  /** Index in the group's `keys`; undefined when an OpenAI-compatible group itself is the credential. */
  keyIndex: number | undefined;
}

interface ConfigCredentialTarget {
  provider: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  groupName: string | undefined;
  openaiCompat: boolean;
  groupAsCredential: boolean;
}

interface LocatedConfigCredential {
  groups: unknown[];
  group: Record<string, unknown>;
  groupIndex: number;
  key: Record<string, unknown>;
  keyIndex: number | undefined;
}

/** Reserved top-level credential field that records ownership and revision. */
const RECONCILE_MARKER = 'x-cpajs';

/** Marks config summaries that came from `api-keys.openai-compatibility`. */
const OPENAI_COMPAT = Symbol('cpajs.openaiCompatibility');

type MarkedConfigSummary = ConfigCredentialSummary & { [OPENAI_COMPAT]?: true };

interface ReconcileMarker {
  owner: string;
  revision?: string;
}

function toBlob(content: CredentialContent): Blob {
  if (content instanceof Blob) return content;
  if (typeof content === 'string') return new Blob([content], { type: 'application/json' });
  if (content instanceof ArrayBuffer || content instanceof Uint8Array) return new Blob([content], { type: 'application/json' });
  return new Blob([JSON.stringify(content)], { type: 'application/json' });
}

/** `/v8/management/credentials*`: OAuth and API-key credential files. */
export class CredentialsResource {
  readonly #t: Transport;
  readonly #config: ConfigResource;
  readonly #definitions = new Map<string, Promise<ModelInfo[]>>();

  constructor(transport: Transport, config: ConfigResource = new ConfigResource(transport)) {
    this.#t = transport;
    this.#config = config;
  }

  /** Lists credentials. Passing `page` or `page_size` enables pagination fields in the response. */
  async list(query: ListCredentialsQuery = {}, options: RequestOptions = {}): Promise<ListCredentialsResponse> {
    return (await this.#t.request<ListCredentialsResponse>({ ...options, method: 'GET', path: '/credentials', query: { ...query } })).data;
  }

  /**
   * Lists credential files and config `api-keys` entries together. Files come from
   * `GET /credentials`; config keys come from `GET /config`, because `/credentials`
   * only exposes a runtime view of them. Runtime state (cooldowns and so on) is not
   * included for config keys.
   */
  async listAll(options: RequestOptions = {}): Promise<CredentialSummary[]> {
    const { files } = await this.list({}, options);
    const config = await this.#readConfig(options);
    return [
      ...files.filter((entry) => entry.source === 'file').map(fileSummary),
      ...configCredentials(config).map((entry) => entry.summary),
    ];
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

  /**
   * Deletes credentials by file name, or one credential by `auth_index`.
   *
   * A config key has no auth file, and upstream `DELETE /credentials` does not
   * touch the config. For an `auth_index` that resolves to a config key this
   * removes the key from its group with {@link ConfigResource.update}, keeping
   * an empty native-provider group (upstream accepts `keys: []`). The last key
   * of an `openai-compatibility` group removes the whole group, because a
   * keyless compat group is itself a credential upstream. An `auth_index` that
   * resolves to a file deletes that file. Partial failures resolve with
   * `status: 'partial'`.
   */
  async delete(target: CredentialDeleteTarget, options: RequestOptions = {}): Promise<DeleteCredentialsResponse> {
    if (typeof target === 'string' || Array.isArray(target)) {
      const list = typeof target === 'string' ? [target] : [...target];
      if (list.length === 0) throw new TypeError('delete needs at least one name.');
      return (await this.#t.request<DeleteCredentialsResponse>({ ...options, method: 'DELETE', path: '/credentials', query: { name: list } }))
        .data;
    }

    const authIndex = readString((target as { auth_index?: unknown }).auth_index);
    if (authIndex === undefined) throw new TypeError('delete needs a name, names or auth_index.');
    const entry = configCredentials(await this.#readConfig(options)).find((credential) => credential.summary.auth_index === authIndex);
    if (entry !== undefined) {
      await this.#deleteConfigCredential(entry, options);
      return { status: 'ok' };
    }

    const [file] = (await this.list({ auth_index: authIndex }, options)).files;
    if (file === undefined) throw this.#credentialNotFound({ auth_index: authIndex });
    return (await this.#t.request<DeleteCredentialsResponse>({ ...options, method: 'DELETE', path: '/credentials', query: { name: [file.name] } }))
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

  /**
   * Models one credential can serve, for a file or a config API key.
   *
   * Pass a `listAll()` summary to skip the `GET /credentials` and `GET /config`
   * lookups; a selector still resolves those from the server.
   *
   * For config keys the resolution follows upstream: the key's `models` list
   * replaces the channel defaults, `alias` is the client-facing ID, a key's
   * `excluded-models` overrides its group's and accepts `*` wildcards, and
   * `display-name` / `max-context-length` / `thinking` override the defaults.
   * File credentials ask `GET /credentials/models`.
   *
   * With `details: true` the channel's `GET /routing/model-definitions/:channel`
   * is merged into each model. Definitions are static for one CPA binary and
   * cached for the lifetime of this resource, so concurrent calls share one
   * request; `refreshDefinitions: true` or {@link clearModelDefinitionsCache}
   * fetches them again.
   *
   * Mirrors CLIProxyAPI v8.0.43 `sdk/cliproxy/service_models.go`
   * (`registerModelsForAuthWithConfigAndCache`, `buildConfigModels`,
   * `applyExcludedModels`, `matchWildcard`) and
   * `internal/watcher/synthesizer/config.go`; key fields inherit from their group in
   * `internal/config/config_v8.go` (`expandV8Groups`).
   */
  async modelsFor(selectorOrSummary: CredentialSelector | CredentialSummary, options: ModelsForOptions = {}): Promise<ModelInfo[]> {
    const { details = false, refreshDefinitions = false, ...requestOptions } = options;
    if (isCredentialSummary(selectorOrSummary)) {
      if (selectorOrSummary.source === 'file') return this.#modelsForFile(selectorOrSummary.raw, details, requestOptions, refreshDefinitions);
      return this.#modelsForConfig(configCredentialFromSummary(selectorOrSummary), details, requestOptions, refreshDefinitions);
    }

    const selector = selectorOrSummary;
    const name = selector.name?.trim() || undefined;
    const authIndex = selector.auth_index?.trim() || undefined;
    if (name === undefined && authIndex === undefined) throw new TypeError('modelsFor needs a name or auth_index.');

    const query: ListCredentialsQuery = name === undefined ? { auth_index: authIndex! } : { name };
    const { files } = await this.list(query, requestOptions);
    const file = files.find(
      (entry) =>
        entry.source === 'file' &&
        (name === undefined || entry.name === name) &&
        (authIndex === undefined || entry.auth_index === authIndex),
    );
    if (file !== undefined) return this.#modelsForFile(file, details, requestOptions, refreshDefinitions);
    if (authIndex === undefined) throw this.#credentialNotFound(name === undefined ? {} : { name });

    const entry = configCredentials(await this.#readConfig(requestOptions)).find(
      (credential) => credential.summary.auth_index === authIndex && (name === undefined || credential.summary.label === name),
    );
    if (entry === undefined) throw this.#credentialNotFound({ auth_index: authIndex, ...(name === undefined ? {} : { name }) });
    return this.#modelsForConfig(entry, details, requestOptions, refreshDefinitions);
  }

  /** Drops cached static model definitions so the next `details: true` call fetches them again. */
  clearModelDefinitionsCache(): void {
    this.#definitions.clear();
  }

  /** Downloads a credential file by file name. The content includes tokens. */
  async download(name: string, options: RequestOptions = {}): Promise<Blob> {
    return (await this.#t.request<Blob>({ ...options, method: 'GET', path: '/credentials/download', query: { name }, responseType: 'blob' })).data;
  }

  /**
   * Aligns the credential files owned by `owner` with `files`.
   *
   * Every upload carries a reserved `x-cpajs: { owner, revision }` field. Only the
   * revision is compared, so a token refresh that rewrites a file does not cause
   * another upload. With `prune` (the default), owned files that are no longer in
   * `files` are deleted; files owned by anyone else are never touched.
   *
   * A file without the marker is never overwritten: reconcile throws
   * {@link CpaReconcileError} with code `unmarked` unless `adopt` claims it.
   * `adopt` returning `{ revision, remove }` deletes the named top-level legacy
   * fields (except `x-cpajs`) before writing the marker. Content may be a parsed
   * object, JSON text or raw bytes; it is normalized to an object before any
   * request is sent.
   */
  async reconcile(input: ReconcileCredentialsInput, options: RequestOptions = {}): Promise<ReconcileCredentialsResult> {
    const { owner, files } = input;
    const prune = input.prune ?? true;
    if (owner.trim() === '') throw new TypeError('reconcile needs a non-empty owner.');

    const desired = new Map<string, { name: string; content: Record<string, unknown>; revision: string }>();
    for (const file of files) {
      if (desired.has(file.name)) throw new TypeError(`reconcile received "${file.name}" more than once.`);
      desired.set(file.name, { name: file.name, content: await reconcileContent(file.name, file.content), revision: file.revision });
    }

    const listed = await this.list({}, options);
    const existing = new Map<string, ReconcileMarker>();
    const claims = new Map<string, string>();
    const unmarked = new Map<string, Record<string, unknown>>();
    const unreadable = new Set<string>();
    for (const entry of listed.files) {
      if (entry.source !== 'file' || !entry.name.toLowerCase().endsWith('.json')) continue;
      if (!prune && !desired.has(entry.name)) continue;
      const body = await this.#readCredentialBody(entry.name, options);
      if (body === undefined) {
        unreadable.add(entry.name);
        continue;
      }
      const marker = reconcileMarker(body);
      if (marker === undefined) {
        unmarked.set(entry.name, body);
        continue;
      }
      claims.set(entry.name, marker.owner);
      if (marker.owner === owner) existing.set(entry.name, marker);
    }

    for (const name of desired.keys()) {
      const claimed = claims.get(name);
      if (claimed !== undefined && claimed !== owner) {
        throw new CpaReconcileError('owned-by-other', name, `Credential "${name}" belongs to owner "${claimed}", not "${owner}".`);
      }
    }

    const adoptions = new Map<string, ReconcileAdoption>();
    if (input.adopt !== undefined) {
      for (const [name, body] of unmarked) {
        const result = await input.adopt(name, body);
        if (result !== undefined) adoptions.set(name, typeof result === 'string' ? { revision: result } : result);
      }
    }

    for (const name of desired.keys()) {
      if (claims.has(name) || adoptions.has(name)) continue;
      if (unmarked.has(name)) {
        throw new CpaReconcileError('unmarked', name, `Credential "${name}" has no x-cpajs marker; pass adopt to claim it.`);
      }
      if (unreadable.has(name)) {
        throw new CpaReconcileError('unmarked', name, `Credential "${name}" has no x-cpajs marker and is not a JSON object; refusing to overwrite it.`);
      }
    }

    const adopted: string[] = [];
    for (const [name, adoption] of adoptions) {
      const kept = removeTopLevelFields(unmarked.get(name)!, adoption.remove);
      await this.upload({ name, content: stampReconcileMarker(kept, owner, adoption.revision) }, options);
      adopted.push(name);
      existing.set(name, { owner, revision: adoption.revision });
    }

    const uploaded: string[] = [];
    const unchanged: string[] = [];
    for (const file of desired.values()) {
      if (existing.get(file.name)?.revision === file.revision) {
        unchanged.push(file.name);
        continue;
      }
      await this.upload({ name: file.name, content: stampReconcileMarker(file.content, owner, file.revision) }, options);
      uploaded.push(file.name);
    }

    const deleted: string[] = [];
    if (prune) {
      for (const name of existing.keys()) {
        if (desired.has(name)) continue;
        await this.delete(name, options);
        deleted.push(name);
      }
    }

    return { uploaded, deleted, unchanged, adopted };
  }

  async #setConfigCredentialStatus(
    entry: ConfigCredential,
    disabled: boolean,
    authIndex: string,
    options: RequestOptions,
  ): Promise<PatchCredentialStatusResponse> {
    if (entry.openaiCompat) {
      throw new Error(
        `Config key "${authIndex}" belongs to an OpenAI-compatible group; upstream has no per-key disabled state, and disabling a keyless group clears its auth_index. Delete the key or group instead.`,
      );
    }
    const target = configCredentialTarget(entry);
    await this.#config.update(
      'api-keys',
      (current) => {
        const found = locateConfigCredential(current, target);
        if (found === undefined) throw this.#credentialNotFound({ auth_index: authIndex }, '/config');
        setExcludedAll(found.key, disabled);
        return current;
      },
      options,
    );
    return { status: 'ok', disabled, via: 'config:excluded-models', excluded_pattern: '*' };
  }

  async #deleteConfigCredential(entry: ConfigCredential, options: RequestOptions): Promise<void> {
    const target = configCredentialTarget(entry);
    await this.#config.update(
      'api-keys',
      (current) => {
        const found = locateConfigCredential(current, target);
        if (found === undefined) throw this.#credentialNotFound({ auth_index: entry.summary.auth_index }, '/config');
        if (target.groupAsCredential) {
          found.groups.splice(found.groupIndex, 1);
          return current;
        }
        const keys = found.group.keys;
        if (!Array.isArray(keys) || found.keyIndex === undefined) {
          throw this.#credentialNotFound({ auth_index: entry.summary.auth_index }, '/config');
        }
        keys.splice(found.keyIndex, 1);
        // Upstream accepts an empty native-provider group and registers no auth for it.
        // A keyless openai-compatibility group is itself a credential, so remove it instead.
        if (keys.length === 0 && target.openaiCompat) found.groups.splice(found.groupIndex, 1);
        return current;
      },
      options,
    );
  }

  #credentialNotFound(selector: CpaCredentialNotFoundSelector, path = '/credentials'): CpaCredentialNotFoundError {
    return new CpaCredentialNotFoundError(selector, { method: 'GET', url: managementUrl(this.#t.baseUrl, path).toString() });
  }

  async #readConfig(options: RequestOptions): Promise<CpaConfig> {
    return (await this.#t.request<CpaConfig>({ ...options, method: 'GET', path: '/config' })).data;
  }

  async #modelDefinitions(channel: string, options: RequestOptions, refresh: boolean): Promise<ModelInfo[]> {
    if (refresh) this.#definitions.delete(channel);
    let pending = this.#definitions.get(channel);
    if (pending === undefined) {
      pending = this.#fetchModelDefinitions(channel, options);
      this.#definitions.set(channel, pending);
      void pending.catch(() => {
        if (this.#definitions.get(channel) === pending) this.#definitions.delete(channel);
      });
    }
    return pending;
  }

  async #fetchModelDefinitions(channel: string, options: RequestOptions): Promise<ModelInfo[]> {
    return (
      await this.#t.request<ModelDefinitionsResponse>({
        ...options,
        method: 'GET',
        path: `/routing/model-definitions/${encodeURIComponent(channel)}`,
      })
    ).data.models;
  }

  async #modelsForFile(entry: AuthFileEntry, details: boolean, options: RequestOptions, refreshDefinitions: boolean): Promise<ModelInfo[]> {
    const { models } = await this.models(entry.name, options);
    const basic = models.map((model) => fileModelInfo(model, entry));
    if (!details) return basic;
    const channel = channelForProvider(entry.provider) ?? channelForProvider(entry.type);
    if (channel === undefined) return basic;
    const definitions = await this.#modelDefinitions(channel, options, refreshDefinitions);
    const byId = new Map(definitions.map((model) => [model.id.toLowerCase(), model]));
    return basic.map((model) => mergeFileModel(model, byId.get(model.id.toLowerCase())));
  }

  async #modelsForConfig(entry: ConfigCredential, details: boolean, options: RequestOptions, refreshDefinitions: boolean): Promise<ModelInfo[]> {
    let models: { upstreamName: string; info: ModelInfo }[] = [];
    if (entry.openaiCompat) {
      models = configuredModels(entry.models ?? [], entry.provider, (model) =>
        'image' in model && model.image ? 'openai-image' : 'openai-compatibility',
      );
    } else {
      const meta = providerModelMeta(entry.provider);
      if (meta !== undefined) {
        if ((entry.models?.length ?? 0) > 0) {
          models = configuredModels(entry.models!, meta.ownedBy, meta.type);
          if (details && entry.channel !== undefined) {
            const definitions = await this.#modelDefinitions(entry.channel, options, refreshDefinitions);
            const byId = new Map(definitions.map((model) => [model.id.toLowerCase(), model]));
            models = models.map((item) => ({
              upstreamName: item.upstreamName,
              info: mergeConfiguredModel(item.info, byId.get(item.upstreamName.toLowerCase()) ?? byId.get(item.info.id.toLowerCase())),
            }));
          }
        } else if (entry.channel !== undefined) {
          const definitions = await this.#modelDefinitions(entry.channel, options, refreshDefinitions);
          models = definitions.map((info) => ({ upstreamName: info.id, info }));
        }
      }
    }
    return excludeModels(
      models.map((item) => item.info),
      entry.excluded ?? [],
    );
  }

  async #readCredentialBody(name: string, options: RequestOptions): Promise<Record<string, unknown> | undefined> {
    const text = await (await this.download(name, options)).text();
    try {
      const content: unknown = JSON.parse(text);
      return isRecord(content) ? content : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Enables or disables a credential file by `name`, or a config key by
   * `auth_index`.
   *
   * Upstream `PATCH /credentials/status` can toggle native `api-keys` entries
   * (it writes `*` to the key's `excluded-models`) but requires the runtime auth
   * ID as `name`, which `GET /credentials` does not expose for config keys. So a
   * request without `name` resolves the config key and edits it through
   * {@link ConfigResource.update} instead: disable appends `*`, enable removes
   * it, leaving the other patterns and the group untouched. A group-level
   * `excluded-models: ["*"]` still disables the key after enabling it, matching
   * upstream. OpenAI-compatible entries have no per-key switch and disabling a
   * keyless group clears its auth_index, so setStatus throws for them; use
   * `delete({ auth_index })` instead.
   *
   * A no-`name` request whose `auth_index` belongs to a file is forwarded to
   * upstream with the file name.
   */
  async setStatus(request: SetCredentialStatusRequest, options: RequestOptions = {}): Promise<PatchCredentialStatusResponse> {
    const name = readString(request.name);
    if (name !== undefined) {
      return (await this.#t.request<PatchCredentialStatusResponse>({ ...options, method: 'PATCH', path: '/credentials/status', json: request })).data;
    }

    const authIndex = readString(request.auth_index);
    if (authIndex === undefined) throw new TypeError('setStatus needs a name or auth_index.');
    const entry = configCredentials(await this.#readConfig(options)).find((credential) => credential.summary.auth_index === authIndex);
    if (entry !== undefined) return this.#setConfigCredentialStatus(entry, request.disabled, authIndex, options);

    const [file] = (await this.list({ auth_index: authIndex }, options)).files;
    if (file === undefined) throw this.#credentialNotFound({ auth_index: authIndex });
    return (
      await this.#t.request<PatchCredentialStatusResponse>({
        ...options,
        method: 'PATCH',
        path: '/credentials/status',
        json: { name: file.name, auth_index: authIndex, disabled: request.disabled },
      })
    ).data;
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

const CONFIG_PROVIDERS = ['gemini', 'interactions', 'claude', 'codex', 'xai', 'meta', 'vertex'] as const;

const PROVIDER_MODEL_META: Record<string, { ownedBy: string; type: string; channel: string }> = {
  gemini: { ownedBy: 'google', type: 'gemini', channel: 'gemini' },
  interactions: { ownedBy: 'google', type: 'gemini', channel: 'gemini-interactions' },
  vertex: { ownedBy: 'google', type: 'vertex', channel: 'vertex' },
  claude: { ownedBy: 'anthropic', type: 'claude', channel: 'claude' },
  codex: { ownedBy: 'openai', type: 'openai', channel: 'codex' },
  xai: { ownedBy: 'xai', type: 'xai', channel: 'xai' },
  meta: { ownedBy: 'meta', type: 'meta', channel: 'meta' },
};

/** Model-definition channel for a credential provider. */
const PROVIDER_CHANNELS: Record<string, string> = {
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  interactions: 'gemini-interactions',
  'gemini-interactions': 'gemini-interactions',
  vertex: 'vertex',
  claude: 'claude',
  codex: 'codex',
  xai: 'xai',
  'x-ai': 'xai',
  grok: 'xai',
  meta: 'meta',
  muse: 'meta',
  kimi: 'kimi',
  'kimi-ai': 'kimi',
  'kimi.ai': 'kimi',
  'kimi.com': 'kimi',
  antigravity: 'antigravity',
  aistudio: 'aistudio',
  devin: 'devin',
};

function channelForProvider(provider: string): string | undefined {
  return PROVIDER_CHANNELS[provider.trim().toLowerCase()];
}

function providerModelMeta(provider: string): { ownedBy: string; type: string; channel: string } | undefined {
  return PROVIDER_MODEL_META[provider.trim().toLowerCase()];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function readModels(value: unknown): ConfiguredModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord) as unknown as ConfiguredModel[];
}

function fileSummary(entry: AuthFileEntry): FileCredentialSummary {
  return {
    auth_index: entry.auth_index,
    provider: entry.provider,
    source: 'file',
    name: entry.name,
    disabled: entry.disabled,
    raw: entry,
  };
}

function isCredentialSummary(value: CredentialSelector | CredentialSummary): value is CredentialSummary {
  return 'source' in value && (value.source === 'file' || value.source === 'config');
}

function isOpenAICompatSummary(summary: ConfigCredentialSummary): boolean {
  if ((summary as MarkedConfigSummary)[OPENAI_COMPAT] === true) return true;
  return !(CONFIG_PROVIDERS as readonly string[]).includes(summary.provider);
}

/** Rebuilds the internal view from a summary without reading `/config` again. */
function configCredentialFromSummary(summary: ConfigCredentialSummary): ConfigCredential {
  const key: Record<string, unknown> = isRecord(summary.raw) ? summary.raw : {};
  const group: Record<string, unknown> = isRecord(summary.group) ? summary.group : {};
  const openaiCompat = isOpenAICompatSummary(summary);
  return {
    summary,
    provider: summary.provider,
    channel: openaiCompat ? undefined : channelForProvider(summary.provider),
    models: openaiCompat ? readModels(group.models) : (readModels(key.models) ?? readModels(group.models)),
    excluded: openaiCompat ? undefined : (readStrings(key['excluded-models']) ?? readStrings(group['excluded-models'])),
    openaiCompat,
    groupIndex: 0,
    keyIndex: undefined,
  };
}

function groupWithoutKeys(group: Record<string, unknown>): Record<string, unknown> {
  const { keys: _keys, ...rest } = group;
  return rest;
}

/**
 * A config key is disabled when `excluded-models` on the key or (inherited from)
 * its group contains `*`. `PATCH /credentials/status` writes exactly that on a
 * config key: `internal/api/handlers/management/config_apikey_disable.go`
 * (`setConfigAPIKeyExcludedAll`) appends the `*` pattern to the key's own
 * `excluded-models`, and `auth_files_fields.go` reports `via:
 * "config:excluded-models"` / `excluded_pattern: "*"`.
 */
function configDisabled(group: Record<string, unknown>, excluded: readonly string[] | undefined): boolean {
  if (group.disabled === true) return true;
  return excluded?.some((item) => item.trim() === '*') === true;
}

/**
 * Flattens the v8 `api-keys` groups into one entry per key. `expandV8Groups` in
 * upstream config_v8.go copies group fields onto each key, so a key-level value
 * replaces the group's and a missing (or null) one inherits it.
 */
function configCredentials(config: CpaConfig): ConfigCredential[] {
  const apiKeys = config['api-keys'] as Record<string, unknown> | undefined;
  if (apiKeys === undefined) return [];
  const out: ConfigCredential[] = [];

  for (const provider of CONFIG_PROVIDERS) {
    const groups = apiKeys[provider];
    if (!Array.isArray(groups)) continue;
    for (const [groupIndex, value] of groups.entries()) {
      if (!isRecord(value)) continue;
      const group = value;
      const label = readString(group.name);
      const groupModels = readModels(group.models);
      const groupExcluded = readStrings(group['excluded-models']);
      const stripped = groupWithoutKeys(group) as unknown as ConfigCredentialGroup;
      const keys = Array.isArray(group.keys) ? group.keys : [];
      for (const [keyIndex, item] of keys.entries()) {
        if (!isRecord(item)) continue;
        const excluded = readStrings(item['excluded-models']) ?? groupExcluded;
        const apiKey = readString(item['api-key']);
        out.push({
          summary: {
            auth_index: readString(item.auth_index) ?? '',
            provider,
            source: 'config',
            ...(label === undefined ? {} : { label }),
            disabled: configDisabled(group, excluded),
            ...(apiKey === undefined ? {} : { apiKey }),
            raw: item as unknown as ConfigCredentialRaw,
            group: stripped,
          },
          provider,
          channel: channelForProvider(provider),
          models: readModels(item.models) ?? groupModels,
          excluded,
          openaiCompat: false,
          groupIndex,
          keyIndex,
        });
      }
    }
  }

  const compatGroups = apiKeys['openai-compatibility'];
  if (Array.isArray(compatGroups)) {
    for (const [groupIndex, value] of compatGroups.entries()) {
      if (!isRecord(value)) continue;
      const group = value;
      const name = readString(group.name);
      const provider = name ?? 'openai-compatibility';
      const models = readModels(group.models);
      const excluded = readStrings(group['excluded-models']);
      const stripped = groupWithoutKeys(group) as unknown as ConfigCredentialGroup;
      const keys = Array.isArray(group.keys) ? group.keys : [];
      // A group without keys is one credential and carries auth_index itself.
      const entries: unknown[] = keys.length > 0 ? keys : [group];
      for (const [entryIndex, item] of entries.entries()) {
        if (!isRecord(item)) continue;
        // A keyless group is itself the credential and has no key entry to expose.
        const apiKey = keys.length > 0 ? readString(item['api-key']) : undefined;
        const summary: MarkedConfigSummary = {
          auth_index: readString(item.auth_index) ?? '',
          provider,
          source: 'config',
          ...(name === undefined ? {} : { label: name }),
          disabled: configDisabled(group, readStrings(item['excluded-models']) ?? excluded),
          ...(apiKey === undefined ? {} : { apiKey }),
          raw: item as unknown as ConfigCredentialRaw,
          group: stripped,
        };
        summary[OPENAI_COMPAT] = true;
        out.push({
          summary,
          provider,
          channel: undefined,
          models,
          excluded: undefined,
          openaiCompat: true,
          groupIndex,
          keyIndex: keys.length > 0 ? entryIndex : undefined,
        });
      }
    }
  }
  return out;
}

function configCredentialTarget(entry: ConfigCredential): ConfigCredentialTarget {
  const group: Record<string, unknown> = isRecord(entry.summary.group) ? entry.summary.group : {};
  const key: Record<string, unknown> = isRecord(entry.summary.raw) ? entry.summary.raw : {};
  return {
    provider: entry.openaiCompat ? 'openai-compatibility' : entry.provider,
    apiKey: readString(key['api-key']),
    baseUrl: readString(group['base-url']),
    groupName: readString(group.name),
    openaiCompat: entry.openaiCompat,
    groupAsCredential: entry.openaiCompat && entry.keyIndex === undefined,
  };
}

/**
 * Finds the key again in a freshly read `api-keys` node. `config.update` strips
 * `auth_index`, so the match uses the stable parts: the API key plus the group's
 * base URL, and the group name for OpenAI-compatible entries.
 */
function locateConfigCredential(apiKeys: unknown, target: ConfigCredentialTarget): LocatedConfigCredential | undefined {
  if (!isRecord(apiKeys)) return undefined;
  const groups = apiKeys[target.provider];
  if (!Array.isArray(groups)) return undefined;

  for (const [groupIndex, value] of groups.entries()) {
    if (!isRecord(value)) continue;
    const group = value;
    if (readString(group['base-url']) !== target.baseUrl) continue;
    if (target.groupAsCredential) {
      if (readString(group.name) === target.groupName) return { groups, group, groupIndex, key: group, keyIndex: undefined };
      continue;
    }
    if (target.openaiCompat && readString(group.name) !== target.groupName) continue;
    const keys = Array.isArray(group.keys) ? group.keys : [];
    for (const [keyIndex, item] of keys.entries()) {
      if (!isRecord(item) || readString(item['api-key']) !== target.apiKey) continue;
      return { groups, group, groupIndex, key: item, keyIndex };
    }
  }

  return undefined;
}

/** Adds or removes the `*` pattern on one key, mirroring upstream `NormalizeExcludedModels`. */
function setExcludedAll(key: Record<string, unknown>, disabled: boolean): void {
  const patterns = readStrings(key['excluded-models']) ?? [];
  const next = normalizeExcludedModels(disabled ? [...patterns, '*'] : patterns.filter((item) => item.trim() !== '*'));
  if (next.length === 0) delete key['excluded-models'];
  else key['excluded-models'] = next;
}

/** Trims, lowercases and dedupes patterns; empty entries are dropped. */
function normalizeExcludedModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function configuredModels(
  models: readonly ConfiguredModel[],
  ownedBy: string,
  type: string | ((model: ConfiguredModel) => string),
): { upstreamName: string; info: ModelInfo }[] {
  const out: { upstreamName: string; info: ModelInfo }[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const modelType = typeof type === 'function' ? type(model) : type;
    const info = configuredModelInfo(model, ownedBy, modelType);
    if (info === undefined) continue;
    const key = info.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ upstreamName: readString(model.name) ?? '', info });
  }
  return out;
}

function configuredModelInfo(model: ConfiguredModel, ownedBy: string, type: string): ModelInfo | undefined {
  const name = readString(model.name) ?? '';
  const alias = readString(model.alias) ?? '';
  const id = alias || name;
  if (id === '') return undefined;
  const info: ModelInfo = {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: ownedBy,
    type,
  };
  const displayName = readString(model['display-name']);
  if (displayName !== undefined) info.display_name = displayName;
  if (typeof model['max-context-length'] === 'number' && model['max-context-length'] > 0) {
    info.context_length = model['max-context-length'];
  }
  const thinking = toThinkingSupport(model.thinking);
  if (thinking !== undefined) info.thinking = thinking;
  return info;
}

function toThinkingSupport(thinking: CpaThinkingSupport | null | undefined): ThinkingSupport | undefined {
  if (thinking === null || thinking === undefined) return undefined;
  const out: ThinkingSupport = {};
  if (typeof thinking.min === 'number') out.min = thinking.min;
  if (typeof thinking.max === 'number') out.max = thinking.max;
  if (typeof thinking['zero-allowed'] === 'boolean') out.zero_allowed = thinking['zero-allowed'];
  if (typeof thinking['dynamic-allowed'] === 'boolean') out.dynamic_allowed = thinking['dynamic-allowed'];
  if (typeof thinking['disable-type'] === 'string') out.disable_type = thinking['disable-type'];
  if (Array.isArray(thinking.levels)) {
    const levels = thinking.levels.filter((level): level is string => typeof level === 'string' && level.trim() !== '');
    if (levels.length > 0) out.levels = levels;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function fileModelInfo(model: CredentialModel, entry: AuthFileEntry): ModelInfo {
  const info: ModelInfo = {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: model.owned_by ?? '',
    type: model.type ?? '',
    ...(model.display_name === undefined ? {} : { display_name: model.display_name }),
  };
  if (info.owned_by === '') info.owned_by = entry.provider;
  if (info.type === '') info.type = entry.type || entry.provider;
  return info;
}

function mergeFileModel(model: ModelInfo, definitions: ModelInfo | undefined): ModelInfo {
  if (definitions === undefined) return model;
  return {
    ...definitions,
    ...model,
    created: definitions.created,
    owned_by: definitions.owned_by || model.owned_by,
    type: definitions.type || model.type,
  };
}

function mergeConfiguredModel(model: ModelInfo, definitions: ModelInfo | undefined): ModelInfo {
  if (definitions === undefined) return model;
  return {
    ...definitions,
    ...model,
    created: definitions.created,
    owned_by: definitions.owned_by || model.owned_by,
    type: definitions.type || model.type,
  };
}

function excludeModels(models: readonly ModelInfo[], excluded: readonly string[]): ModelInfo[] {
  const patterns = excluded.map((item) => item.trim().toLowerCase()).filter((item) => item !== '');
  if (patterns.length === 0) return [...models];
  return models.filter((model) => {
    const id = model.id.trim().toLowerCase();
    return !patterns.some((pattern) => matchWildcard(pattern, id));
  });
}

/** Case-insensitive wildcard match where `*` matches any substring. Mirrors upstream `matchWildcard`. */
function matchWildcard(pattern: string, value: string): boolean {
  if (pattern === '') return false;
  if (!pattern.includes('*')) return pattern === value;

  const parts = pattern.split('*');
  let rest = value;
  const prefix = parts[0]!;
  if (prefix !== '') {
    if (!rest.startsWith(prefix)) return false;
    rest = rest.slice(prefix.length);
  }
  const suffix = parts[parts.length - 1]!;
  if (suffix !== '') {
    if (!rest.endsWith(suffix)) return false;
    rest = rest.slice(0, -suffix.length);
  }
  for (let index = 1; index < parts.length - 1; index++) {
    const segment = parts[index]!;
    if (segment === '') continue;
    const found = rest.indexOf(segment);
    if (found < 0) return false;
    rest = rest.slice(found + segment.length);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reconcileMarker(content: Record<string, unknown>): ReconcileMarker | undefined {
  const marker = content[RECONCILE_MARKER];
  if (!isRecord(marker) || typeof marker.owner !== 'string') return undefined;
  return {
    owner: marker.owner,
    ...(typeof marker.revision === 'string' ? { revision: marker.revision } : {}),
  };
}

/** Resolves reconcile content to a JSON object; strings and bytes must parse to one. */
async function reconcileContent(name: string, content: CredentialContent): Promise<Record<string, unknown>> {
  let value: unknown = content;
  if (typeof content === 'string') {
    value = parseCredentialJson(content);
  } else if (content instanceof Blob) {
    value = parseCredentialJson(await content.text());
  } else if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
    value = parseCredentialJson(new TextDecoder().decode(content));
  }
  if (!isRecord(value)) throw new TypeError(`reconcile content for "${name}" must be a JSON object.`);
  return value;
}

function parseCredentialJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Copies content without the requested top-level fields; the reconcile marker is never removed. */
function removeTopLevelFields(content: Record<string, unknown>, remove: readonly string[] | undefined): Record<string, unknown> {
  if (remove === undefined || remove.length === 0) return content;
  const next = { ...content };
  for (const field of remove) {
    if (field === RECONCILE_MARKER) continue;
    delete next[field];
  }
  return next;
}

/** Returns a new content object with the marker set; the caller's object is untouched. */
function stampReconcileMarker(content: Record<string, unknown>, owner: string, revision: string): Record<string, unknown> {
  const current = content[RECONCILE_MARKER];
  return {
    ...content,
    [RECONCILE_MARKER]: { ...(isRecord(current) ? current : {}), owner, revision },
  };
}
