import { CpaStartError } from './errors.ts';
import type { StartServerOptions } from './types.ts';

// Flags that make cli-proxy-api run a one-shot command or an interactive UI instead of the server.
const COMMAND_FLAGS = new Set([
  'codex-login',
  'codex-device-login',
  'claude-login',
  'antigravity-login',
  'kimi-login',
  'kimi-ai-login',
  'xai-login',
  'devin-login',
  'meta-login',
  'discover',
  'discover-json',
  'vertex-import',
  'siwc-bind',
  'tui',
  'standalone',
  'management-base-url',
]);
// Flags startServer sets itself.
const MANAGED_FLAGS: Record<string, string> = {
  config: 'config / configPath',
  'local-model': 'localModel',
  'home-jwt': 'home.jwt',
  'home-disable-cluster-discovery': 'home.disableClusterDiscovery',
  password: 'management.key',
};

function flagName(arg: string): string | undefined {
  const match = /^--?([A-Za-z0-9][\w.-]*)(?:=.*)?$/.exec(arg);
  return match?.[1];
}

/** CLI arguments after `-config <file>`: typed options first, then `args`. */
export function buildArgs(options: StartServerOptions): string[] {
  for (const arg of options.args ?? []) {
    const name = flagName(arg);
    if (name === undefined) continue;
    if (COMMAND_FLAGS.has(name)) {
      throw new CpaStartError('invalid-options', `args must not contain -${name}: it runs a one-shot command instead of the server.`);
    }
    const option = MANAGED_FLAGS[name];
    if (option) throw new CpaStartError('invalid-options', `Use the ${option} option instead of passing -${name} in args.`);
  }
  const argv: string[] = [];
  if (options.localModel) argv.push('-local-model');
  if (options.home?.disableClusterDiscovery) argv.push('-home-disable-cluster-discovery');
  argv.push(...(options.args ?? []));
  return argv;
}
