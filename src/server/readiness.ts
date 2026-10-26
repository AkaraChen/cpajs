import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';

/** Hostname to connect to for a configured bind host. */
export function connectHost(bindHost: string): string {
  if (bindHost === '' || bindHost === '0.0.0.0') return '127.0.0.1';
  if (bindHost === '::' || bindHost === '[::]') return '::1';
  return bindHost;
}

/** True when a bind host only accepts loopback connections. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '' || normalized === '0.0.0.0' || normalized === '::') return false;
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:127.')) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
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

/** A free port whose probing listener stays open until `release()` is called. */
export interface PortReservation {
  port: number;
  /** Closes the probing listener so a child process can bind the port. */
  release(): Promise<void>;
}

/**
 * Reserves a currently free TCP port on `host`.
 *
 * The listening socket is left open until `release()` so another process cannot
 * take the port while the caller finishes preparing the child. The window
 * between `release()` and the child's own bind cannot be removed entirely.
 */
export function findFreePort(host: string): Promise<PortReservation> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: connectHost(host), port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      if (!port) {
        server.close(() => reject(new Error('Could not allocate a free port.')));
        return;
      }
      let released: Promise<void> | undefined;
      resolve({
        port,
        release() {
          released ??= new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          });
          return released;
        },
      });
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
