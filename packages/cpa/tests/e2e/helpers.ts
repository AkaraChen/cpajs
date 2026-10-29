import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateTargets, currentPlatform, resolveBinary } from '../../src/server/binary.ts';
import { binaryName } from '../../src/server/targets.ts';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/**
 * The binary under test: `CPA_BINARY`, else an installed platform package,
 * else a local build in dist-bin/. Undefined when none exists.
 */
export function findBinary(): string | undefined {
  if (process.env.CPA_BINARY) return process.env.CPA_BINARY;
  try {
    return resolveBinary().path;
  } catch {
    // Fall back to local builds.
  }
  for (const target of candidateTargets(currentPlatform())) {
    const path = join(ROOT, 'dist-bin', target.id, binaryName(target));
    if (existsSync(path)) return path;
  }
  return undefined;
}

export interface FakeUpstream {
  url: string;
  requests: { method: string; path: string; headers: IncomingMessage['headers']; body: string }[];
  close(): Promise<void>;
}

/** An OpenAI-compatible upstream with one model, `fake-model`, that streams two chunks. */
export async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'fake' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const parsed = JSON.parse(body || '{}') as { stream?: boolean };
      const base = { id: 'chatcmpl-1', created: 1, model: 'fake-model' };
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for (const content of ['Hello', ' world']) {
          const chunk = { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          await new Promise((r) => setTimeout(r, 50));
        }
        const done = { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        res.write(`data: ${JSON.stringify(done)}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
      return;
    }
    if (req.url?.startsWith('/echo')) {
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Echo': 'yes' });
      res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null, body }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Polls `fn` until it returns true. */
export async function eventually(fn: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}
