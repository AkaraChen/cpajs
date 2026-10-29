/**
 * Prints the GitHub Actions build matrix derived from packages/cpa/src/server/targets.ts.
 *
 *   node scripts/ci-matrix.ts   # → {"include":[{target, runner, smoke, qemu, ...}]}
 */
import { appendFileSync } from 'node:fs';
import { TARGETS, type Target } from '../packages/cpa/src/server/targets.ts';

interface MatrixEntry {
  target: string;
  runner: string;
  /** Start the binary and run HTTP checks after building. */
  smoke: boolean;
  /** Install qemu-user-static (registers binfmt_misc) for an emulated smoke test. */
  qemu: boolean;
  /** Install clang + lld for the FreeBSD CGO cross build. */
  freebsdSysroot: boolean;
}

function runner(t: Target): string {
  if (t.os === 'darwin') return t.cpu === 'arm64' ? 'macos-15' : 'macos-15-intel';
  if (t.os === 'win32') return t.cpu === 'arm64' ? 'windows-11-arm' : 'windows-latest';
  if (t.os === 'linux' && t.cpu === 'arm64') return 'ubuntu-24.04-arm';
  return 'ubuntu-latest';
}

export function matrix(): { include: MatrixEntry[] } {
  return {
    include: TARGETS.map((t) => ({
      target: t.id,
      runner: runner(t),
      smoke: t.verification !== 'cross-compiled',
      qemu: t.verification === 'emulated',
      freebsdSysroot: t.goos === 'freebsd' && t.build === 'plugin',
    })),
  };
}

if (import.meta.main) {
  const json = JSON.stringify(matrix());
  console.log(json);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${json}\n`);
}
