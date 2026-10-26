import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { CPA_RELEASE } from '../src/server/cpa-version.ts';
import { TARGETS, type Target } from '../src/server/targets.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(ROOT, '.cache');
export const DEFAULT_SOURCE_DIR = join(CACHE_DIR, 'cpa-src', CPA_RELEASE.tag);
export const DEFAULT_BIN_DIR = join(ROOT, 'dist-bin');
export const DEFAULT_NPM_DIR = join(ROOT, 'dist-npm');

export function args<T extends NonNullable<ParseArgsConfig['options']>>(options: T) {
  return parseArgs({ options, allowPositionals: false, strict: true }).values;
}

export function findTarget(id: string | undefined): Target {
  const target = TARGETS.find((t) => t.id === id);
  if (!target) fail(`Unknown target ${String(id)}. Known: ${TARGETS.map((t) => t.id).join(', ')}`);
  return target;
}

/** Targets selected by `--target a,b` or `--all`. */
export function selectTargets(values: { target?: string | undefined; all?: boolean | undefined }): Target[] {
  if (values.all) return [...TARGETS];
  if (!values.target) fail('Pass --target <id>[,<id>...] or --all.');
  return values.target.split(',').map((id) => findTarget(id.trim()));
}

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function log(message: string): void {
  console.log(`[cpajs] ${message}`);
}

/** Runs a command with inherited stdio; rejects on non-zero exit. */
export function run(
  command: string,
  argv: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; shell?: boolean; quiet?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argv], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', options.quiet ? 'ignore' : 'inherit'] : 'inherit',
      // Needed to run .cmd shims (npm, pnpm) on Windows.
      shell: options.shell ?? false,
    });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${command} ${argv.join(' ')} exited with code ${String(code)}`));
    });
  });
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Metadata written next to each binary and shipped in its platform package. */
export interface BuildInfo {
  target: string;
  package: string;
  binary: string;
  sha256: string;
  size: number;
  cpa: typeof CPA_RELEASE;
  go: { version: string; goos: string; goarch: string; env: Record<string, string> };
  build: Target['build'];
  cgo: boolean;
  plugins: boolean;
  /** Model catalogs are the ones embedded in the pinned source, not refreshed at build time. */
  modelCatalogs: 'embedded-at-pinned-commit';
  flags: string[];
  ldflags: string;
  toolchain: string;
  verification: Target['verification'];
  /** cpa-launcher built from launcher/ (absent on Windows targets). */
  launcher?: { file: string; sha256: string; size: number };
}
