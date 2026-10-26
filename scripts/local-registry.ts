/**
 * A tiny npm registry for install tests: serves packages from local tarballs
 * and proxies everything else to the public registry. It lets npm, pnpm and
 * bun resolve the platform packages through their real os/cpu/libc rules
 * before anything is published.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { run } from './lib.ts';

const UPSTREAM = 'https://registry.npmjs.org';

interface LocalVersion {
  manifest: Record<string, unknown> & { name: string; version: string };
  tarball: Buffer;
  file: string;
}

async function readManifest(tgz: string): Promise<LocalVersion['manifest']> {
  const text = await run('tar', ['-xOzf', tgz, 'package/package.json'], { capture: true });
  return JSON.parse(text) as LocalVersion['manifest'];
}

export interface LocalRegistry {
  url: string;
  packages: string[];
  close(): Promise<void>;
}

export async function startLocalRegistry(tarballDir: string): Promise<LocalRegistry> {
  const local = new Map<string, LocalVersion>();
  for (const file of (await readdir(tarballDir)).filter((f) => f.endsWith('.tgz'))) {
    const path = join(tarballDir, file);
    const manifest = await readManifest(path);
    local.set(manifest.name, { manifest, tarball: await readFile(path), file });
  }

  let origin = '';
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const name = decodeURIComponent(url.pathname.slice(1));
      const tarballMatch = /^\/-\/tarballs\/(.+)$/.exec(url.pathname);
      if (tarballMatch) {
        const entry = [...local.values()].find((v) => v.file === decodeURIComponent(tarballMatch[1]!));
        if (!entry) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': entry.tarball.length });
        res.end(entry.tarball);
        return;
      }
      const entry = local.get(name);
      if (entry) {
        const { manifest, tarball, file } = entry;
        const version = {
          ...manifest,
          _id: `${manifest.name}@${manifest.version}`,
          dist: {
            tarball: `${origin}/-/tarballs/${encodeURIComponent(file)}`,
            shasum: createHash('sha1').update(tarball).digest('hex'),
            integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
          },
        };
        const packument = { name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: version } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(packument));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      // Proxy everything else (packuments, tarballs, audit 404s) to the public registry.
      const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
        headers: { accept: req.headers.accept ?? 'application/json' },
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${origin}/`, packages: [...local.keys()], close: () => new Promise((resolve) => server.close(() => resolve())) };
}
