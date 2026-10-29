/**
 * Configures npm trusted publishing (GitHub Actions OIDC) for every published
 * workspace package (WORKSPACE_PACKAGES) and every platform package. Run it locally once the packages exist on the
 * registry (npm cannot trust unpublished packages):
 *
 *   node scripts/trust-publishers.ts [--dry-run]
 *
 * The trust endpoints reject tokens, including granular tokens that bypass 2FA,
 * so the script ignores any token you already have. It uses a temporary npm
 * config and logs in there once with `npm login --auth-type=web` (browser +
 * 2FA). At the first trust call npm asks for 2FA again and offers to skip it
 * for five minutes, which covers all packages. Afterwards the temporary session
 * is logged out and the config removed. Packages that already have a trust
 * relationship are skipped, so the script can be re-run.
 *
 * Needs npm >= 11.15.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TARGETS, packageName } from '../packages/cpa/src/server/targets.ts';
import { WORKSPACE_PACKAGES, args, log, run } from './lib.ts';

const REPOSITORY = 'AkaraChen/cpajs';
const WORKFLOW = 'release.yml';
const ENVIRONMENT = 'npm';
const REGISTRY = 'https://registry.npmjs.org/';

function hasTrust(json: string): boolean {
  try {
    const data = JSON.parse(json) as unknown;
    if (Array.isArray(data)) return data.length > 0;
    return typeof data === 'object' && data !== null && Object.keys(data).length > 0;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const values = args({ 'dry-run': { type: 'boolean' } });
  const packages = [...TARGETS.map(packageName), ...WORKSPACE_PACKAGES.map((pkg) => pkg.name)];
  const shell = process.platform === 'win32';

  const dir = await mkdtemp(join(tmpdir(), 'cpajs-trust-'));
  const userconfig = join(dir, '.npmrc');
  await writeFile(userconfig, `registry=${REGISTRY}\n`, { mode: 0o600 });
  // Only the temporary config counts: drop tokens from the environment and the
  // global config so npm cannot fall back to a 2FA-bypassing token.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: join(dir, 'global-npmrc'),
    npm_config_registry: REGISTRY,
    NODE_AUTH_TOKEN: undefined,
    npm_config__authToken: undefined,
  };
  const npm = (argv: string[], capture = false, quiet = false) => run('npm', argv, { env, shell, capture, quiet });
  let loggedIn = false;

  try {
    // npm can only trust packages that exist; check them all before changing anything.
    const missing: string[] = [];
    for (const name of packages) {
      await npm(['view', name, 'name'], true, true).catch(() => missing.push(name));
    }
    if (missing.length) throw new Error(`not published yet (wait for the release workflow to finish): ${missing.join(', ')}`);

    if (values['dry-run']) {
      for (const name of packages) log(`would trust ${name} → ${REPOSITORY} ${WORKFLOW} (environment ${ENVIRONMENT})`);
    } else {
      log('logging in to npm (a browser window opens; complete the login with 2FA)');
      await npm(['login', '--auth-type=web']);
      loggedIn = true;
      log(`logged in as ${(await npm(['whoami'], true)).trim()}`);

      for (const [i, name] of packages.entries()) {
        const existing = await npm(['trust', 'list', name, '--json'], true, true).catch(() => '');
        if (hasTrust(existing)) {
          log(`(${i + 1}/${packages.length}) ${name} already has a trust relationship, skipping`);
          continue;
        }
        log(`(${i + 1}/${packages.length}) trusting ${name}`);
        await npm(['trust', 'github', name, '--file', WORKFLOW, '--repo', REPOSITORY, '--env', ENVIRONMENT, '--allow-publish', '--yes']);
        // npm recommends spacing out trust calls to avoid rate limiting.
        await delay(2_000);
      }
      log('done. Releases publish through trusted publishing (OIDC).');
    }
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    if (loggedIn) await npm(['logout']).catch(() => log('warning: npm logout failed; revoke the session on npmjs.com if needed'));
    await rm(dir, { recursive: true, force: true });
  }
}
