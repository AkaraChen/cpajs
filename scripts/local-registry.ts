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
import { gunzipSync } from 'node:zlib';

const UPSTREAM = 'https://registry.npmjs.org';

interface LocalVersion {
  manifest: Record<string, unknown> & { name: string; version: string };
  tarball: Buffer;
  file: string;
}

/** Reads package/package.json from an npm tarball without an external tar binary. */
function readManifest(tarball: Buffer): LocalVersion['manifest'] {
  const tar = gunzipSync(tarball);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (name === '') break;
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const body = offset + 512;
    if (name === 'package/package.json') {
      return JSON.parse(tar.subarray(body, body + size).toString('utf8')) as LocalVersion['manifest'];
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error('package/package.json not found in tarball');
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
    const tarball = await readFile(path);
    const manifest = readManifest(tarball);
    local.set(manifest.name, { manifest, tarball, file });
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
