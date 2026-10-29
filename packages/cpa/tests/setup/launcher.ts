// Builds cpa-launcher once for the launcher tests (POSIX only). Locally the tests
// skip when Go is unavailable; in CI a missing launcher is an error.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
export const TEST_LAUNCHER = join(ROOT, '.cache', 'test-launcher', 'cpa-launcher');

export default function setup(): void {
  if (process.platform === 'win32') return;
  mkdirSync(dirname(TEST_LAUNCHER), { recursive: true });
  try {
    execFileSync('go', ['build', '-o', TEST_LAUNCHER, '.'], { cwd: join(ROOT, 'launcher'), stdio: 'pipe', env: { ...process.env, CGO_ENABLED: '0' } });
  } catch (error) {
    if (process.env.CI) throw new Error(`could not build cpa-launcher for the tests: ${String(error)}`);
    if (!existsSync(TEST_LAUNCHER)) console.warn('cpa-launcher could not be built (no Go?); launcher tests will be skipped');
  }
}
