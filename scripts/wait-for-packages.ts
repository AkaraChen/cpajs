/**
 * Waits until every platform package resolves at a version on the npm registry.
 *
 * The release workflow publishes the platform packages first and runs this
 * before the main package. `@cpajs/cpa` lists every platform package as an
 * optional dependency, so all of them must be installable when a consumer
 * resolves the main package. Installers resolve a package from the abbreviated
 * packument (`GET /<pkg>`, not `/<pkg>/<version>`), so that is what we probe:
 * the packument must contain `versions[version]`. Registry metadata (including
 * 404s) is cached by the CDN and different edges can lag independently, so each
 * probe sends no-cache headers and a unique query parameter, and a package
 * needs two consecutive successful polls before it counts as resolved.
 *
 *   node scripts/wait-for-packages.ts --version 0.1.0-rc.5
 *   node scripts/wait-for-packages.ts --version 0.0.0-does-not-exist --timeout 5 --interval 1
 *
 * Defaults: the version in package.json, a 10 minute timeout and a 10 second
 * poll interval.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TARGETS, packageName } from '../src/server/targets.ts';
import { ROOT, args, fail, log } from './lib.ts';

const REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_SECONDS = 10 * 60;
const DEFAULT_INTERVAL_SECONDS = 10;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
/** The same representation npm, pnpm and bun ask for when they install a package. */
const INSTALL_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
const REQUIRED_CONFIRMATIONS = 2;
const REQUEST_TIMEOUT_DETAIL = 'request timed out';

interface Probe {
  ok: boolean;
  detail: string;
}

function seconds(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`--${name} must be a positive number of seconds, got ${value}`);
  return parsed;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

/** The registry accepts the scope's @ but needs the slash escaped in the path. */
function encodePackage(name: string): string {
  return name.replace('/', '%2f');
}

let probeCount = 0;

async function probe(name: string, version: string, timeoutMs: number): Promise<Probe> {
  // The timestamp alone can collide for parallel probes in the same millisecond.
  const url = `${REGISTRY}/${encodePackage(name)}?cpajs=${Date.now()}-${probeCount++}`;
  try {
    const response = await fetch(url, {
      headers: {
        accept: INSTALL_ACCEPT,
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return { ok: false, detail: 'not found (404)' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    const packument = (await response.json()) as { name?: unknown; versions?: unknown };
    if (packument.name !== undefined && packument.name !== name) {
      return { ok: false, detail: `unexpected packument for ${String(packument.name)}` };
    }
    const versions = packument.versions;
    if (typeof versions !== 'object' || versions === null || Array.isArray(versions)) {
      return { ok: false, detail: 'packument has no versions' };
    }
    if (!Object.hasOwn(versions, version)) {
      return { ok: false, detail: `version ${version} is missing from the packument` };
    }
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: (error as Error).name === 'TimeoutError' ? REQUEST_TIMEOUT_DETAIL : (error as Error).message };
  }
}

if (import.meta.main) {
  const values = args({
    version: { type: 'string' },
    timeout: { type: 'string' },
    interval: { type: 'string' },
  });
  const version = (values.version ?? (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version).trim();
  if (!version) fail('--version must not be empty');
  const timeoutMs = seconds(values.timeout, DEFAULT_TIMEOUT_SECONDS, 'timeout') * 1000;
  const intervalMs = seconds(values.interval, DEFAULT_INTERVAL_SECONDS, 'interval') * 1000;

  const packages = TARGETS.map(packageName);
  const resolved = new Set<string>();
  const confirmations = new Map<string, number>();
  const details = new Map<string, string>();
  const deadline = Date.now() + timeoutMs;

  log(`waiting for ${packages.length} platform packages at ${version} (timeout ${formatDuration(timeoutMs)})`);
  while (resolved.size < packages.length) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const pending = packages.filter((name) => !resolved.has(name));
    const requestTimeout = Math.max(1, Math.min(MAX_REQUEST_TIMEOUT_MS, remaining));
    const results = await Promise.all(pending.map(async (name) => [name, await probe(name, version, requestTimeout)] as const));
    for (const [name, result] of results) {
      if (result.ok) {
        const count = (confirmations.get(name) ?? 0) + 1;
        if (count < REQUIRED_CONFIRMATIONS) {
          confirmations.set(name, count);
          details.set(name, 'packument resolved once; awaiting a second consecutive poll');
          continue;
        }
        confirmations.delete(name);
        resolved.add(name);
        details.delete(name);
        log(`resolved ${name}@${version} (${resolved.size}/${packages.length})`);
      } else {
        // One bad poll breaks the streak: the next success starts over at one.
        confirmations.delete(name);
        // Keep a concrete earlier result when the last probe merely ran out of budget.
        if (result.detail !== REQUEST_TIMEOUT_DETAIL || !details.has(name)) details.set(name, result.detail);
      }
    }
    if (resolved.size === packages.length) break;

    const left = deadline - Date.now();
    if (left <= 0) break;
    log(`${packages.length - resolved.size} platform package(s) not yet confirmed; retrying in ${formatDuration(intervalMs)}`);
    await delay(Math.min(intervalMs, left));
  }

  const unresolved = packages.filter((name) => !resolved.has(name));
  if (unresolved.length) {
    fail(
      `timed out after ${formatDuration(timeoutMs)} waiting for ${unresolved.length}/${packages.length} platform package(s) at ${version}; the main package must not be published:\n` +
        unresolved.map((name) => `  ${name}@${version}: ${details.get(name) ?? 'not checked'}`).join('\n'),
    );
  }
  log(`all ${packages.length} platform packages resolve at ${version}`);
}
