// Manage an existing CLIProxyAPI instance.
//   CPA_URL=https://cpa.example.com CPA_MANAGEMENT_KEY=... node examples/remote-client.ts
import { CpaHttpError, createClient } from '@cpajs/cpa/client';

const client = createClient({
  baseUrl: process.env.CPA_URL ?? 'http://127.0.0.1:8317',
  managementKey: process.env.CPA_MANAGEMENT_KEY ?? '',
  timeoutMs: 15_000,
});

try {
  const info = await client.server.info();
  const latest = await client.server.latestVersion();
  console.log(`CPA ${info.version} (latest ${latest}), plugins ${info.supportPlugin ? 'on' : 'off'}`);

  for (const file of (await client.credentials.list()).files) {
    console.log(`${file.provider.padEnd(12)} ${file.name} ${file.status}${file.disabled ? ' (disabled)' : ''}`);
  }
} catch (error: unknown) {
  if (error instanceof CpaHttpError && error.status === 401) console.error('wrong management key');
  else throw error;
}
