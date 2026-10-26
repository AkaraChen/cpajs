#!/usr/bin/env node
// Minimal stand-in for cli-proxy-api used by lifecycle tests.
// Reads `-config <file>` (JSON), serves GET /healthz on server.host/port.
// Behaviour switches (environment):
//   FAKE_EXIT=<code>        exit immediately with <code> after printing a line
//   FAKE_BIND_ERROR=<n>     for the first <n> runs (counted in FAKE_COUNTER), print CPA's bind
//                           error and exit 0, like the real binary
//   FAKE_IGNORE_TERM=1      ignore SIGTERM
//   FAKE_DELAY_MS=<ms>      wait before listening
//   FAKE_ECHO=<text>        print <text> on stdout and stderr at startup
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const configPath = args[args.indexOf('-config') + 1];
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const host = config.server?.host || '127.0.0.1';
const port = config.server?.port;

console.log(`fake cpa starting with ${args.join(' ')}`);
if (process.env.HOME_JWT) console.log(`HOME_JWT length ${process.env.HOME_JWT.length}`);
if (process.env.MANAGEMENT_PASSWORD) console.log(`MANAGEMENT_PASSWORD length ${process.env.MANAGEMENT_PASSWORD.length}`);
if (process.env.FAKE_ECHO) {
  console.log(`stdout: ${process.env.FAKE_ECHO}`);
  console.error(`stderr: ${process.env.FAKE_ECHO}`);
}
if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
const runs = process.env.FAKE_COUNTER && existsSync(process.env.FAKE_COUNTER) ? Number(readFileSync(process.env.FAKE_COUNTER, 'utf8')) + 1 : 1;
if (process.env.FAKE_COUNTER) writeFileSync(process.env.FAKE_COUNTER, String(runs));
if (process.env.FAKE_BIND_ERROR && runs <= Number(process.env.FAKE_BIND_ERROR)) {
  console.log(`proxy service exited with error: failed to start HTTP server: listen tcp ${host}:${port}: bind: address already in use`);
  process.exit(0);
}
if (process.env.FAKE_IGNORE_TERM) process.on('SIGTERM', () => console.log('ignoring SIGTERM'));

setTimeout(() => {
  createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404);
    res.end();
  }).listen(port, host, () => console.log(`API server started successfully on: ${host}:${port}`));
}, Number(process.env.FAKE_DELAY_MS ?? 0));
