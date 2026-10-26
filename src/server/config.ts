import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CpaConfig } from '../client/types/config.ts';
import { CpaStartError } from './errors.ts';

export const DEFAULT_PORT = 8317;
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

/**
 * Reads listener settings from a parsed config document. The v8 `server.*`
 * keys win over the legacy top-level `host`/`port`/`tls` keys, mirroring CPA.
 */
export function readListenSettings(doc: unknown): ListenSettings {
  const root = isRecord(doc) ? doc : {};
  const server = isRecord(root.server) ? root.server : {};
  const pick = (key: string): unknown => (key in server ? server[key] : root[key]);

  const host = pick('host');
  const port = pick('port');
  const tls = pick('tls');
  const parsedPort = typeof port === 'number' ? port : typeof port === 'string' ? Number(port) : Number.NaN;
  return {
    host: typeof host === 'string' ? host.trim() : '',
    // CPA falls back to 8317 when the port is missing or not positive.
    port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : port === 0 ? 0 : DEFAULT_PORT,
    tls: isRecord(tls) && tls.enable === true,
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
    doc = parseYaml(text);
  } catch (cause) {
    throw new CpaStartError('invalid-options', `configPath ${absolute} is not valid YAML.`, { cause });
  }
  const listen = readListenSettings(doc);
  if (listen.port === 0) {
    throw new CpaStartError(
      'invalid-options',
      `configPath ${absolute} sets port 0. CLIProxyAPI does not report the port it picks, so set a fixed port or pass a config object instead.`,
    );
  }
  return { configPath: absolute, listen, secrets: configSecrets(doc), managed: false };
}
