import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CpaConfig } from '../client/types/config.ts';
import { CpaStartError } from './errors.ts';

export const MANAGED_CONFIG_FILE = 'config.yaml';

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
  return Object.prototype.hasOwnProperty.call(value, key);
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
  secrets: string[];
  /** True when the file was written by this package. */
  managed: boolean;
}

/**
 * Writes a `config` object to the managed config file in `stateDir`.
 *
 * The object is serialised as JSON, which is valid YAML and is read by CPA's
 * YAML loader unchanged. Listener and auth directory defaults are filled in so
 * the process stays inside `stateDir` and binds to loopback unless told otherwise.
 */
export async function writeManagedConfig(
  config: CpaConfig,
  stateDir: string,
  listen: { host: string; port: number },
): Promise<PreparedConfig> {
  const doc = structuredClone(config) as Json;
  const server = isRecord(doc.server) ? doc.server : {};
  doc.server = { ...server, host: listen.host, port: listen.port };
  if (doc['config-version'] === undefined) doc['config-version'] = 8;
  const oauth = isRecord(doc.oauth) ? doc.oauth : {};
  // Keep credentials inside stateDir unless the config chooses a location (v8 or legacy key).
  if (oauth['auth-dir'] === undefined && doc['auth-dir'] === undefined) {
    const authDir = join(stateDir, 'auths');
    await mkdir(authDir, { recursive: true });
    doc.oauth = { ...oauth, 'auth-dir': authDir };
  }

  const configPath = join(stateDir, MANAGED_CONFIG_FILE);
  await writeFile(configPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  return { configPath, listen: readListenSettings(doc), secrets: configSecrets(doc), managed: true };
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
  if (!Number.isInteger(listen.port) || listen.port <= 0 || listen.port > 65_535) {
    const shown = Number.isNaN(listen.port) ? 'a non-numeric value' : String(listen.port);
    throw new CpaStartError(
      'invalid-options',
      `configPath ${absolute} does not set a fixed port between 1 and 65535 (got ${shown}). CLIProxyAPI does not default the port: a missing or non-positive port becomes 0 and binds a random port it does not report. Set a fixed port or pass a config object instead.`,
    );
  }
  return { configPath: absolute, listen, secrets: configSecrets(doc), managed: false };
}
