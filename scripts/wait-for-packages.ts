/**
 * Waits until every platform package resolves at a version on the npm registry.
 *
 * The release workflow publishes the platform packages first and runs this
 * before the main package. `@cpajs/cpa` lists every platform package as an
 * optional dependency, so all of them must be installable when a consumer
 * resolves the main package. Registry metadata (including 404s) is cached by
 * the CDN and can lag behind the publish, so each probe sends no-cache headers
 * and a unique query parameter.
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
  const url = `${REGISTRY}/${encodePackage(name)}/${encodeURIComponent(version)}?cpajs=${Date.now()}-${probeCount++}`;
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
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
    const manifest = (await response.json()) as { name?: unknown; version?: unknown };
    if (manifest.version !== version || (manifest.name !== undefined && manifest.name !== name)) {
      return { ok: false, detail: `unexpected manifest ${String(manifest.name)}@${String(manifest.version)}` };
    }
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
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
        resolved.add(name);
        details.delete(name);
        log(`resolved ${name}@${version} (${resolved.size}/${packages.length})`);
      } else {
        details.set(name, result.detail);
      }
    }
    if (resolved.size === packages.length) break;

    const left = deadline - Date.now();
    if (left <= 0) break;
    log(`${packages.length - resolved.size} platform package(s) still not resolving; retrying in ${formatDuration(intervalMs)}`);
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
