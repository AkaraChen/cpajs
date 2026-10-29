/**
 * Configures npm trusted publishing (GitHub Actions OIDC) for every published
 * workspace package (WORKSPACE_PACKAGES) and every platform package. Run it locally once the packages exist on the
 * registry (npm cannot trust unpublished packages):
 *
 *   node scripts/trust-publishers.ts [--dry-run] [--only <name>[,<name>...]]
 *
 * The trust endpoints reject tokens, including granular tokens that bypass 2FA,
 * so the script ignores any token you already have. It uses a temporary npm
 * config and logs in there once with `npm login --auth-type=web` (browser +
 * 2FA). At the first trust call npm asks for 2FA again and offers to skip it
 * for five minutes, which covers all packages. Afterwards the temporary session
 * is logged out and the config removed. Packages that already have a trust
 * relationship are skipped (npm answers 409 for them), so the script can be re-run;
 * `--only` limits it to the named packages, e.g. a package that was just added.
 *
 * Needs npm >= 11.15.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TARGETS, packageName } from '../packages/cpa/src/server/targets.ts';
import { WORKSPACE_PACKAGES, args, fail, log, run } from './lib.ts';

const REPOSITORY = 'AkaraChen/cpajs';
const WORKFLOW = 'release.yml';
const ENVIRONMENT = 'npm';
const REGISTRY = 'https://registry.npmjs.org/';

/**
 * Runs npm with the terminal attached (it may ask for 2FA in the browser) and
 * returns its exit code and stderr, which is also echoed.
 */
function npmTee(argv: string[], env: NodeJS.ProcessEnv, shell: boolean): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', argv, { env, shell, stdio: ['inherit', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

if (import.meta.main) {
  const values = args({ 'dry-run': { type: 'boolean' }, only: { type: 'string' } });
  const all = [...TARGETS.map(packageName), ...WORKSPACE_PACKAGES.map((pkg) => pkg.name)];
  const only = values.only?.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = only?.filter((name) => !all.includes(name)) ?? [];
  if (unknown.length) fail(`not a released package: ${unknown.join(', ')}`);
  const packages = only ?? all;
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

      // `npm trust list` needs 2FA too, so instead of checking first, try every package
      // and treat npm's 409 (a matching configuration already exists) as "already trusted".
      const failed: string[] = [];
      for (const [i, name] of packages.entries()) {
        log(`(${i + 1}/${packages.length}) trusting ${name}`);
        const { code, stderr } = await npmTee(
          ['trust', 'github', name, '--file', WORKFLOW, '--repo', REPOSITORY, '--env', ENVIRONMENT, '--allow-publish', '--yes'],
          env,
          shell,
        );
        if (code === 0) log(`${name}: trusted`);
        else if (/E409|already exists/.test(stderr)) log(`${name}: already has a trust relationship, skipping`);
        else failed.push(name);
        // npm recommends spacing out trust calls to avoid rate limiting.
        if (i < packages.length - 1) await delay(2_000);
      }
      if (failed.length) throw new Error(`could not trust: ${failed.join(', ')} (re-run with --only ${failed.join(',')})`);
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
