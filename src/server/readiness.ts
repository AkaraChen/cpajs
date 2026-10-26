import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';

/** Hostname to connect to for a configured bind host. */
export function connectHost(bindHost: string): string {
  if (bindHost === '' || bindHost === '0.0.0.0') return '127.0.0.1';
  if (bindHost === '::' || bindHost === '[::]') return '::1';
  return bindHost;
}

export function formatOrigin(protocol: 'http' | 'https', host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${protocol}://${h}:${port}`;
}

/**
 * Single `GET /healthz` probe. Certificate checks are skipped because the probe
 * only targets the child process this package just started.
 */
export function probeHealth(origin: string, timeoutMs: number): Promise<boolean> {
  const url = new URL('/healthz', origin);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET', timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Asks the OS for a currently free TCP port on `host`. */
export function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: connectHost(host), port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a free port.'))));
    });
  });
}

/** Resolves to true when nothing is listening on `host:port`. */
export function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'EADDRINUSE'));
    // An empty bind host means all interfaces, which is what CPA binds in that case.
    server.listen({ host: host === '' ? undefined : host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
