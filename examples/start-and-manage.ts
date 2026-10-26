// Start a bundled CLIProxyAPI, change its config and list credentials.
//   node examples/start-and-manage.ts
import { createClient } from '@cpajs/cpa/client';
import { startServer } from '@cpajs/cpa/server';

const managementKey = 'example-management-key';
const server = await startServer({
  management: { key: managementKey },
  localModel: true,
  config: { access: { 'api-keys': ['example-model-key'] } },
});

try {
  const client = createClient({ baseUrl: server.origin, managementKey });
  console.log('running', await client.server.info(), 'at', server.origin);

  const { etag } = await client.config.get();
  await client.config.patch({ routing: { strategy: 'fill-first' } }, { ifMatch: etag });
  console.log('strategy is now', (await client.config.getPath('routing/strategy')).data);

  const { files } = await client.credentials.list();
  console.log(`${files.length} credentials`);
  console.log('point OpenAI-compatible SDKs at', server.baseUrl);
} finally {
  await server.stop();
}
