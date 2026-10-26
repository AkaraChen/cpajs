import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';
import type { CpaConfig } from '../client/types/config.ts';
import { CpaStartError } from './errors.ts';

export const MANAGED_CONFIG_FILE = 'config.yaml';

export interface ManagementSettings {
  /** `management.allow-remote`, falling back to the legacy `remote-management` key. */
  allowRemote: boolean;
  /** True when the document already has a non-empty `secret-key`. */
  hasSecret: boolean;
  /** The stored `secret-key` (plaintext or a bcrypt hash), if any. */
  secretKey: string | undefined;
}

export interface ListenSettings {
  /** The `server.host` value as configured; empty means all interfaces. */
  host: string;
  port: number;
  tls: boolean;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Json, key: string): boolean {
  return Object.hasOwn(value, key);
}

/**
 * Decodes a port like yaml.v3 decodes into an int: null (and a missing key)
 * becomes 0, a finite float is truncated, and anything else is NaN. CPA does
 * not default the port, so 0 must stay 0 instead of becoming 8317.
 */
function readPort(value: unknown, present: boolean): number {
  if (!present || value === null || value === undefined) return 0;
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
}

/**
 * Reads listener settings from a parsed config document using upstream's
 * presence-based precedence: a `server.*` leaf wins whenever it is present,
 * even when it is `0`, `false` or `null` (internal/config/config_v8.go).
 * Legacy top-level `host`/`port`/`tls` are used only when that v8 leaf is
 * absent, and `tls.enable` is resolved leaf by leaf rather than by replacing
 * the whole `tls` object.
 */
export function readListenSettings(doc: unknown): ListenSettings {
  const root = isRecord(doc) ? doc : {};
  const server = isRecord(root.server) ? root.server : {};
  const serverTls = isRecord(server.tls) ? server.tls : undefined;
  const legacyTls = isRecord(root.tls) ? root.tls : undefined;

  const v8Port = hasOwn(server, 'port');
  const host = hasOwn(server, 'host') ? server.host : root.host;
  const port = readPort(v8Port ? server.port : root.port, v8Port || hasOwn(root, 'port'));

  let tls: unknown;
  if (serverTls !== undefined && hasOwn(serverTls, 'enable')) tls = serverTls.enable;
  else if (legacyTls !== undefined && hasOwn(legacyTls, 'enable')) tls = legacyTls.enable;

  return {
    host: typeof host === 'string' ? host.trim() : '',
    port,
    tls: tls === true,
  };
}

/**
 * Reads management settings from a parsed config document. The v8 `management`
 * section wins over the legacy `remote-management` alias, mirroring CPA.
 */
export function readManagementSettings(doc: unknown): ManagementSettings {
  const root = isRecord(doc) ? doc : {};
  const section = isRecord(root.management)
    ? root.management
    : isRecord(root['remote-management'])
      ? root['remote-management']
      : {};
  const secret = section['secret-key'];
  return {
    allowRemote: section['allow-remote'] === true,
    hasSecret: typeof secret === 'string' && secret.trim() !== '',
    secretKey: typeof secret === 'string' && secret.trim() !== '' ? secret : undefined,
  };
}

// Only known secret keys are collected. Open-ended maps such as `headers`,
// `payload` and `plugins.configs.*` can hold credentials under arbitrary names;
// they are deliberately skipped so an ordinary config value is never mistaken
// for a secret and redacted out of unrelated log lines. Pass `redact` to
// startServer for those.
const SECRET_FIELDS = new Set(['secret-key', 'api-key', 'github-token', 'credential', 'access_token', 'refresh_token']);
const SECRET_LISTS = new Set(['api-keys']);

/** Secrets that appear in a config document and must never reach logs. */
export function configSecrets(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown, key: string | undefined): void => {
    if (typeof value === 'string') {
      if (key !== undefined && SECRET_FIELDS.has(key) && value !== '') out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && key !== undefined && SECRET_LISTS.has(key) && item !== '') out.push(item);
        else walk(item, undefined);
      }
      return;
    }
    if (isRecord(value)) for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(doc, undefined);
  return out;
}

export interface PreparedConfig {
  configPath: string;
  listen: ListenSettings;
  management: ManagementSettings;
  secrets: string[];
  /** True when the file belongs to the managed state directory. */
  managed: boolean;
  /** True when an existing file was reused instead of written. */
  reused: boolean;
}

/**
 * Writes a `config` object to the managed config file in `stateDir`.
 *
 * The object is serialised as YAML so CPA and humans see the same stable shape.
 * Listener and auth directory defaults are filled in so the process stays inside
 * `stateDir` and binds to loopback unless told otherwise.
 */
export async function writeManagedConfig(
  config: CpaConfig,
  stateDir: string,
  listen: { host: string; port: number },
  management?: { secretKeyHash: string; allowRemote: boolean },
): Promise<PreparedConfig> {
  const doc = structuredClone(config) as Json;
  const server = isRecord(doc.server) ? doc.server : {};
  doc.server = { ...server, host: listen.host, port: listen.port };
  if (doc['config-version'] === undefined) doc['config-version'] = 8;
  if (management !== undefined) {
    const section = isRecord(doc.management) ? doc.management : {};
    doc.management = {
      ...section,
      'secret-key': management.secretKeyHash,
      'allow-remote': management.allowRemote,
    };
  }
  const oauth = isRecord(doc.oauth) ? doc.oauth : {};
  // Keep credentials inside stateDir unless the config chooses a location (v8 or legacy key).
  if (oauth['auth-dir'] === undefined && doc['auth-dir'] === undefined) {
    const authDir = join(stateDir, 'auths');
    await mkdir(authDir, { recursive: true });
    doc.oauth = { ...oauth, 'auth-dir': authDir };
  }

  const configPath = join(stateDir, MANAGED_CONFIG_FILE);
  await writeFile(configPath, stringifyYaml(doc), { mode: 0o600 });
  return {
    configPath,
    listen: readListenSettings(doc),
    management: readManagementSettings(doc),
    secrets: configSecrets(doc),
    managed: true,
    reused: false,
  };
}

function isFixedPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

/**
 * Reads the managed config file in `stateDir` without modifying it.
 *
 * Returns `undefined` when the file does not exist yet. An existing file must
 * set a fixed `server.port`, because CPA does not report the port it picks and
 * a later start cannot discover it.
 */
export async function readManagedConfig(stateDir: string): Promise<PreparedConfig | undefined> {
  const configPath = join(stateDir, MANAGED_CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CpaStartError('invalid-options', `Cannot read ${configPath}.`, { cause });
  }
  let doc: unknown;
  try {
    doc = parseYaml(text, { merge: true });
  } catch (cause) {
    throw new CpaStartError('invalid-options', `${configPath} is not valid YAML.`, { cause });
  }
  const listen = readListenSettings(doc);
  if (!isFixedPort(listen.port)) {
    throw new CpaStartError(
      'invalid-options',
      `${configPath} does not set a fixed server.port. CLIProxyAPI does not report the port it picks; set server.port, delete the file, or pass overwriteConfig: true.`,
    );
  }
  return {
    configPath,
    listen,
    management: readManagementSettings(doc),
    secrets: configSecrets(doc),
    managed: true,
    reused: true,
  };
}

/**
 * Sets `management.secret-key` and `management.allow-remote` in a reused
 * managed config, leaving every other key and comment as CPA left them.
 * The legacy `remote-management` section is dropped so it cannot shadow them.
 */
export async function updateManagedSecret(
  configPath: string,
  management: { secretKeyHash: string; allowRemote: boolean },
): Promise<void> {
  const document = parseDocument(await readFile(configPath, 'utf8'), { merge: true });
  document.delete('remote-management');
  document.setIn(['management', 'secret-key'], management.secretKeyHash);
  document.setIn(['management', 'allow-remote'], management.allowRemote);
  await writeFile(configPath, document.toString(), { mode: 0o600 });
}

/** Reads an existing config file without modifying it. */
export async function inspectConfigFile(configPath: string): Promise<PreparedConfig> {
  const absolute = resolve(configPath);
  let text: string;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (cause) {
    throw new CpaStartError('invalid-options', `Cannot read configPath ${absolute}.`, { cause });
  }
  let doc: unknown;
  try {
    doc = parseYaml(text, { merge: true });
  } catch (cause) {
    throw new CpaStartError('invalid-options', `configPath ${absolute} is not valid YAML.`, { cause });
  }
  const root = isRecord(doc) ? doc : {};
  if (hasOwn(root, 'server') && !isRecord(root.server)) {
    throw new CpaStartError('invalid-options', `configPath ${absolute} has a "server" section that is not a mapping.`);
  }
  if (isRecord(root.server) && hasOwn(root.server, 'tls') && !isRecord(root.server.tls)) {
    throw new CpaStartError('invalid-options', `configPath ${absolute} has a "server.tls" section that is not a mapping.`);
  }
  const listen = readListenSettings(doc);
  if (!isFixedPort(listen.port)) {
    const shown = Number.isNaN(listen.port) ? 'a non-numeric value' : String(listen.port);
    throw new CpaStartError(
      'invalid-options',
      `configPath ${absolute} does not set a fixed port between 1 and 65535 (got ${shown}). CLIProxyAPI does not default the port: a missing or non-positive port becomes 0 and binds a random port it does not report. Set a fixed port or pass a config object instead.`,
    );
  }
  return {
    configPath: absolute,
    listen,
    management: readManagementSettings(doc),
    secrets: configSecrets(doc),
    managed: false,
    reused: false,
  };
}
