/**
 * Verifies built binaries and optionally smoke-tests them.
 *
 *   node scripts/verify-binary.ts --target linux-x64-gnu[,..] [--dir dist-bin] [--smoke]
 *   node scripts/verify-binary.ts --all [--dir dist-bin]
 *
 * Static checks: checksum matches BUILD-INFO.json, executable format and CPU
 * match the target, portable Linux builds have no dynamic interpreter, and
 * glibc builds need at most GLIBC_2.17.
 *
 * --smoke starts the binary through startServer() (natively, or under QEMU
 * when binfmt_misc is registered) and checks /healthz, the management API and
 * the model API.
 */
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '../src/client/index.ts';
import { CPA_RELEASE } from '../src/server/cpa-version.ts';
import { startServer } from '../src/server/index.ts';
import { binaryName, type Target } from '../src/server/targets.ts';
import { DEFAULT_BIN_DIR, args, fail, log, selectTargets, sha256File, type BuildInfo } from './lib.ts';

const GLIBC_BASELINE = [2, 17];

const ELF_MACHINE: Record<string, number> = {
  amd64: 62,
  arm64: 183,
  arm: 40,
  '386': 3,
  riscv64: 243,
  ppc64le: 21,
  s390x: 22,
  loong64: 258,
  mips: 8,
  mipsle: 8,
};
const PE_MACHINE: Record<string, number> = { amd64: 0x8664, arm64: 0xaa64, '386': 0x14c };
const MACHO_CPU: Record<string, number> = { amd64: 0x01000007, arm64: 0x0100000c };

interface ElfInfo {
  machine: number;
  interpreter: string | undefined;
}

function parseElf(buf: Buffer): ElfInfo {
  const is64 = buf[4] === 2;
  const le = buf[5] === 1;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o: number) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const machine = u16(18);
  const phoff = is64 ? u64(32) : u32(28);
  const phentsize = u16(is64 ? 54 : 42);
  const phnum = u16(is64 ? 56 : 44);
  let interpreter: string | undefined;
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    if (u32(ph) !== 3 /* PT_INTERP */) continue;
    const offset = is64 ? u64(ph + 8) : u32(ph + 4);
    const size = is64 ? u64(ph + 32) : u32(ph + 16);
    interpreter = buf.subarray(offset, offset + size).toString('latin1').replace(/\0+$/, '');
  }
  return { machine, interpreter };
}

function maxGlibc(buf: Buffer): number[] | undefined {
  let max: number[] | undefined;
  for (const match of buf.toString('latin1').matchAll(/GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)) {
    const version = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    if (!max || compare(version, max) > 0) max = version;
  }
  return max;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function staticChecks(target: Target, binary: string): Promise<string[]> {
  const problems: string[] = [];
  const handle = await open(binary, 'r');
  const head = Buffer.alloc(64);
  await handle.read(head, 0, 64, 0);
  await handle.close();

  if (target.goos === 'windows') {
    const buf = await readFile(binary);
    if (buf.toString('latin1', 0, 2) !== 'MZ') return ['not a PE executable'];
    const pe = buf.readUInt32LE(0x3c);
    const machine = buf.readUInt16LE(pe + 4);
    if (machine !== PE_MACHINE[target.goarch]) problems.push(`PE machine 0x${machine.toString(16)} does not match ${target.goarch}`);
    return problems;
  }
  if (target.goos === 'darwin') {
    if (head.readUInt32LE(0) !== 0xfeedfacf) return ['not a 64-bit Mach-O executable'];
    const cpu = head.readUInt32LE(4);
    if (cpu !== MACHO_CPU[target.goarch]) problems.push(`Mach-O cpu 0x${cpu.toString(16)} does not match ${target.goarch}`);
    return problems;
  }

  if (head.toString('latin1', 0, 4) !== '\x7fELF') return ['not an ELF executable'];
  const buf = await readFile(binary);
  const elf = parseElf(buf);
  if (elf.machine !== ELF_MACHINE[target.goarch]) problems.push(`ELF machine ${elf.machine} does not match ${target.goarch}`);
  const bigEndian = buf[5] === 2;
  if (target.goarch === 'mips' && !bigEndian) problems.push('expected big-endian MIPS');
  if (target.goarch === 'mipsle' && bigEndian) problems.push('expected little-endian MIPS');

  if (target.build === 'portable' && target.goos === 'linux' && elf.interpreter) {
    problems.push(`portable build requests a dynamic interpreter (${elf.interpreter})`);
  }
  if (target.libc === 'glibc') {
    if (!elf.interpreter) problems.push('glibc build is unexpectedly static');
    const max = maxGlibc(buf);
    if (max && compare(max, GLIBC_BASELINE) > 0) problems.push(`requires GLIBC_${max.join('.')}, baseline is ${GLIBC_BASELINE.join('.')}`);
    log(`${target.id}: interpreter ${String(elf.interpreter)}, max GLIBC ${max ? max.join('.') : 'none'}`);
  }
  return problems;
}

async function smoke(target: Target, binary: string): Promise<void> {
  const managementKey = 'smoke-management-key';
  const modelKey = 'smoke-model-key';
  const server = await startServer({
    binaryPath: binary,
    managementKey,
    args: ['-local-model'],
    startupTimeoutMs: 120_000,
    config: { access: { 'api-keys': [modelKey] }, management: { 'disable-control-panel': true } },
  });
  try {
    const client = createClient({ baseUrl: server.origin, managementKey, timeoutMs: 30_000 });
    const info = await client.server.info();
    if (info.version !== CPA_RELEASE.version) throw new Error(`X-CPA-VERSION is ${info.version}, expected ${CPA_RELEASE.version}`);
    const expectPlugin = target.build === 'plugin';
    if (info.supportPlugin !== expectPlugin) throw new Error(`X-CPA-SUPPORT-PLUGIN is ${String(info.supportPlugin)}, expected ${String(expectPlugin)}`);
    const { data } = await client.config.get();
    if (data.server?.port !== server.port) throw new Error('config round trip did not return the bound port');
    const models = await fetch(`${server.baseUrl}/models`, { headers: { Authorization: `Bearer ${modelKey}` } });
    if (models.status !== 200) throw new Error(`GET /v1/models returned ${models.status}`);
    log(`${target.id}: smoke test passed on ${server.origin} (version ${info.version}, plugins ${String(info.supportPlugin)})`);
  } finally {
    const exit = await server.stop();
    log(`${target.id}: stopped with ${JSON.stringify(exit)}`);
  }
}

if (import.meta.main) {
  const values = args({ target: { type: 'string' }, all: { type: 'boolean' }, dir: { type: 'string' }, smoke: { type: 'boolean' } });
  const dir = values.dir ?? DEFAULT_BIN_DIR;
  let failed = false;
  for (const target of selectTargets(values)) {
    const binary = join(dir, target.id, binaryName(target));
    const info = JSON.parse(await readFile(join(dir, target.id, 'BUILD-INFO.json'), 'utf8')) as BuildInfo;
    const problems = await staticChecks(target, binary);
    const sha = await sha256File(binary);
    if (sha !== info.sha256) problems.push(`sha256 ${sha} does not match BUILD-INFO.json ${info.sha256}`);
    if (info.target !== target.id || info.cpa.commit !== CPA_RELEASE.commit) problems.push('BUILD-INFO.json does not match this target/release');
    if (problems.length) {
      failed = true;
      console.error(`FAIL ${target.id}:\n  - ${problems.join('\n  - ')}`);
      continue;
    }
    log(`${target.id}: static checks passed`);
    if (values.smoke) await smoke(target, binary);
  }
  if (failed) fail('verification failed');
}
