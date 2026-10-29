// Complete a native OAuth login, for a running server or a temporary local one.
//
//   node examples/oauth-login.ts
//   CPA_URL=https://cpa.example.com CPA_MANAGEMENT_KEY=... node examples/oauth-login.ts
//
// If the browser runs on another machine, either pass CPA_OAUTH_WEBUI=1 so CPA shows
// the redirect URL, or set CPA_OAUTH_REDIRECT_URL (or paste it when prompted).
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { CpaHttpError, createClient, type CpaClient } from '@cpajs/cpa/client';
import { startServer, type CpaServer } from '@cpajs/cpa/server';

const provider = process.env.CPA_OAUTH_PROVIDER ?? 'claude';
const webui = ['1', 'true', 'yes'].includes((process.env.CPA_OAUTH_WEBUI ?? '').toLowerCase());
const redirectUrl = process.env.CPA_OAUTH_REDIRECT_URL;
const managementKey = process.env.CPA_MANAGEMENT_KEY ?? `cpa-example-${Date.now().toString(36)}`;

let server: CpaServer | undefined;
try {
  let client: CpaClient;
  if (process.env.CPA_URL) {
    client = createClient({ baseUrl: process.env.CPA_URL, managementKey, timeoutMs: 30_000 });
  } else {
    server = await startServer({ managementKey, localModel: true });
    client = createClient({ baseUrl: server.origin, managementKey, timeoutMs: 30_000 });
    console.log(`started CPA at ${server.origin}`);
  }

  const session = await client.oauth.start({ provider, ...(webui ? { is_webui: true } : {}) });
  console.log(`\nOpen this URL in a browser:\n${session.url}\n`);
  if ('user_code' in session && session.user_code) console.log(`Device code: ${session.user_code}`);

  let callback = redirectUrl;
  if (!callback && !webui && stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      callback =
        (await rl.question('If the browser cannot reach this machine, paste the final redirect URL (or press Enter): ')).trim() ||
        undefined;
    } finally {
      rl.close();
    }
  }
  if (callback) {
    await client.oauth.callback({ redirect_url: callback });
    console.log('handed the redirect URL to CPA');
  }

  console.log(`waiting for the ${provider} login to finish...`);
  const result = await client.oauth.waitForCompletion(session.state, { intervalMs: 1_500 });
  if (result.status === 'error') {
    console.error(`login failed: ${result.error}`);
    process.exitCode = 1;
  } else {
    const { files } = await client.credentials.list();
    console.log('login complete; credentials:');
    for (const file of files) console.log(`  ${file.provider.padEnd(12)} ${file.name}`);
  }
} catch (error) {
  if (error instanceof CpaHttpError) console.error(`CPA returned ${error.status}: ${error.errorCode ?? error.message}`);
  else throw error;
  process.exitCode = 1;
} finally {
  await server?.stop();
}
