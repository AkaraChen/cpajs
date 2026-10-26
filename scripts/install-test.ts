/**
 * Installs the packed packages into a fresh project through a local registry
 * and checks that the package manager picked the right platform package and
 * that CPA starts without any configuration.
 *
 *   node scripts/install-test.ts --tarballs dist-npm/tarballs --pm npm|pnpm|bun [--runtime node|bun] [--expect <target>] [--typecheck]
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateTargets, currentPlatform } from '../src/server/binary.ts';
import { TARGETS, packageName } from '../src/server/targets.ts';
import { DEFAULT_NPM_DIR, args, fail, log, run } from './lib.ts';
import { startLocalRegistry } from './local-registry.ts';

const CHECK_SCRIPT = `
import { createRequire } from 'node:module';
import { TARGETS, packageName, resolveBinary, startServer } from '@cpajs/cpa/server';
import { createClient } from '@cpajs/cpa/client';

const require = createRequire(import.meta.resolve('@cpajs/cpa/server'));
const installed = TARGETS.map(packageName).filter((name) => {
  try { require.resolve(name + '/package.json'); return true; } catch { return false; }
});
const binary = resolveBinary();
const server = await startServer({
  managementKey: 'install-test-key',
  args: ['-local-model'],
  config: { management: { 'disable-control-panel': true } },
  startupTimeoutMs: 60000,
});
try {
  const client = createClient({ baseUrl: server.origin, managementKey: 'install-test-key' });
  const info = await client.server.info();
  console.log(JSON.stringify({ installed, resolved: binary.packageName, version: info.version, supportPlugin: info.supportPlugin }));
} finally {
  await server.stop();
}
`;

const TYPECHECK_SOURCE = `
import { createClient, CpaHttpError, type CpaConfig, type AuthFileEntry } from '@cpajs/cpa/client';
import { startServer, type CpaServer } from '@cpajs/cpa/server';
import * as root from '@cpajs/cpa';

const config: CpaConfig = { routing: { strategy: 'fill-first' }, access: { 'api-keys': ['k'] } };
export async function main(): Promise<AuthFileEntry[]> {
  const server: CpaServer = await startServer({ config });
  const client = createClient({ baseUrl: server.origin, managementKey: 'k' });
  try {
    return (await client.credentials.list()).files;
  } catch (error) {
    if (error instanceof CpaHttpError) console.log(error.status);
    throw error;
  } finally {
    await server.stop();
  }
}
export const same = root.createClient === createClient;
`;

if (import.meta.main) {
  const values = args({
    tarballs: { type: 'string' },
    pm: { type: 'string' },
    runtime: { type: 'string' },
    expect: { type: 'string' },
    typecheck: { type: 'boolean' },
    keep: { type: 'boolean' },
  });
  const pm = values.pm ?? 'npm';
  const runtime = values.runtime ?? 'node';
  const expected = values.expect ?? candidateTargets(currentPlatform())[0]?.id;
  if (!expected) fail('No target for this platform; pass --expect.');

  const registry = await startLocalRegistry(values.tarballs ?? join(DEFAULT_NPM_DIR, 'tarballs'));
  const mainManifest = registry.packages.includes('@cpajs/cpa');
  if (!mainManifest) fail('No @cpajs/cpa tarball found.');
  log(`local registry ${registry.url} serving ${registry.packages.length} packages`);

  const dir = await mkdtemp(join(tmpdir(), 'cpajs-install-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_registry: registry.url,
    npm_config_cache: join(dir, '.npm-cache'),
    BUN_CONFIG_REGISTRY: registry.url,
    BUN_INSTALL_CACHE_DIR: join(dir, '.bun-cache'),
    // Never let the test pick up a binary from the environment.
    CPA_BINARY: undefined,
  };
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'cpajs-install-test', private: true, type: 'module' }, null, 2));
    await writeFile(join(dir, '.npmrc'), `registry=${registry.url}\n`);
    const extra = values.typecheck ? ['typescript@^7', '@types/node@^24'] : [];
    const shell = process.platform === 'win32';
    const install: Record<string, [string, string[]]> = {
      npm: ['npm', ['install', '--no-audit', '--no-fund', '@cpajs/cpa', ...extra]],
      pnpm: ['pnpm', ['add', '--store-dir', join(dir, '.pnpm-store'), '@cpajs/cpa', ...extra]],
      bun: ['bun', ['add', '@cpajs/cpa', ...extra]],
      yarn: ['yarn', ['add', '@cpajs/cpa', ...extra]],
    };
    const command = install[pm];
    if (!command) fail(`Unknown package manager ${pm}`);
    log(`installing with ${pm}`);
    await run(command[0], command[1], { cwd: dir, env, shell });

    await writeFile(join(dir, 'check.mjs'), CHECK_SCRIPT);
    const output = await run(runtime, ['check.mjs'], { cwd: dir, env, capture: true });
    const result = JSON.parse(output.trim().split('\n').at(-1)!) as {
      installed: string[];
      resolved: string;
      version: string;
      supportPlugin: boolean;
    };
    log(`installed platform packages: ${result.installed.join(', ') || 'none'}`);
    log(`resolved ${result.resolved}, CPA ${result.version}, plugins ${String(result.supportPlugin)}`);

    const expectedTarget = TARGETS.find((t) => t.id === expected)!;
    const problems: string[] = [];
    if (result.resolved !== packageName(expectedTarget)) problems.push(`resolved ${result.resolved}, expected ${packageName(expectedTarget)}`);
    for (const name of result.installed) {
      const t = TARGETS.find((x) => packageName(x) === name)!;
      if (t.os !== expectedTarget.os || t.cpu !== expectedTarget.cpu) problems.push(`installed foreign package ${name}`);
      else if (t !== expectedTarget) log(`warning: ${pm} also installed ${name} (ignores the libc field); it is unused`);
    }
    if (result.supportPlugin !== (expectedTarget.build === 'plugin')) problems.push(`supportPlugin ${String(result.supportPlugin)} does not match ${expectedTarget.build}`);

    if (values.typecheck) {
      await writeFile(join(dir, 'check.ts'), TYPECHECK_SOURCE);
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'nodenext', target: 'es2023', strict: true, noEmit: true, types: ['node'], skipLibCheck: false }, files: ['check.ts'] }),
      );
      await run(join(dir, 'node_modules', '.bin', 'tsc'), ['-p', '.'], { cwd: dir, env, shell });
      log('consumer typecheck passed');
    }

    if (problems.length) fail(problems.join('\n'));
    log(`install test passed (${pm} + ${runtime})`);
  } finally {
    await registry.close();
    if (!values.keep) await rm(dir, { recursive: true, force: true });
    else log(`kept ${dir}`);
  }
}
