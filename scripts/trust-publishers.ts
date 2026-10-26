/**
 * Configures npm trusted publishing (GitHub Actions OIDC) for the main package
 * and every platform package. Run it locally, logged in to npm with 2FA,
 * after the packages exist on the registry (npm cannot trust unpublished packages).
 *
 *   node scripts/trust-publishers.ts [--dry-run]
 *
 * Needs npm >= 11.15 and an interactive `npm login` session with 2FA:
 * granular tokens that bypass 2FA are rejected by the trust endpoints (401),
 * so unset NPM_TOKEN / NODE_AUTH_TOKEN / npm_config__authToken first. After the
 * first 2FA prompt npm offers to skip 2FA for five minutes, which covers all packages.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { TARGETS, packageName } from '../src/server/targets.ts';
import { args, fail, log, run } from './lib.ts';

const REPOSITORY = 'AkaraChen/cpajs';
const WORKFLOW = 'release.yml';
const ENVIRONMENT = 'npm';

if (import.meta.main) {
  const values = args({ 'dry-run': { type: 'boolean' } });
  const packages = [...TARGETS.map(packageName), '@cpajs/cpa'];
  const shell = process.platform === 'win32';

  // npm can only trust packages that exist; check them all before changing anything.
  const missing: string[] = [];
  for (const name of packages) {
    try {
      await run('npm', ['view', name, 'name'], { shell, capture: true });
    } catch {
      missing.push(name);
    }
  }
  if (missing.length) {
    fail(`not published yet (wait for the release workflow to finish): ${missing.join(', ')}`);
  }
  for (const [i, name] of packages.entries()) {
    const argv = ['trust', 'github', name, '--file', WORKFLOW, '--repo', REPOSITORY, '--env', ENVIRONMENT, '--allow-publish', '--yes'];
    log(`(${i + 1}/${packages.length}) npm ${argv.join(' ')}`);
    if (values['dry-run']) continue;
    await run('npm', argv, { shell }).catch((error: unknown) => {
      fail(
        `${String(error)}\nA 401 here usually means npm is using a token instead of a 2FA login session: ` +
          'unset NPM_TOKEN / NODE_AUTH_TOKEN, run `npm login`, then re-run this script. Packages configured before ' +
          'the failure already have a trust relationship (see `npm trust list <package>`).',
      );
    });
    // npm recommends spacing out trust calls to avoid rate limiting.
    await delay(2_000);
  }
  log('done. Remove the NPM_TOKEN secret and revoke the token; later releases use OIDC.');
}
