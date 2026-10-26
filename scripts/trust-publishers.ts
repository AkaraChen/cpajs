/**
 * Configures npm trusted publishing (GitHub Actions OIDC) for the main package
 * and every platform package. Run it locally, logged in to npm with 2FA,
 * after the packages exist on the registry (npm cannot trust unpublished packages).
 *
 *   node scripts/trust-publishers.ts [--dry-run]
 *
 * Needs npm >= 11.15. After the first 2FA prompt npm offers to skip 2FA for
 * five minutes, which covers all packages.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { TARGETS, packageName } from '../src/server/targets.ts';
import { args, log, run } from './lib.ts';

const REPOSITORY = 'AkaraChen/cpa-js';
const WORKFLOW = 'release.yml';
const ENVIRONMENT = 'npm';

if (import.meta.main) {
  const values = args({ 'dry-run': { type: 'boolean' } });
  const packages = [...TARGETS.map(packageName), '@cpajs/cpa'];
  const shell = process.platform === 'win32';
  for (const [i, name] of packages.entries()) {
    const argv = ['trust', 'github', name, '--file', WORKFLOW, '--repo', REPOSITORY, '--env', ENVIRONMENT, '--allow-publish', '--yes'];
    log(`(${i + 1}/${packages.length}) npm ${argv.join(' ')}`);
    if (values['dry-run']) continue;
    await run('npm', argv, { shell });
    // npm recommends spacing out trust calls to avoid rate limiting.
    await delay(2_000);
  }
  log('done. Remove the NPM_TOKEN secret and revoke the token; later releases use OIDC.');
}
