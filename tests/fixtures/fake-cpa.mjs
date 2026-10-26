#!/usr/bin/env node
// Minimal stand-in for cli-proxy-api used by lifecycle tests.
// Reads `-config <file>` (YAML), serves GET /healthz on server.host/port.
// Behaviour switches (environment):
//   FAKE_EXIT=<code>        exit immediately with <code> after printing a line
//   FAKE_EXIT_AFTER=<n>     only apply FAKE_EXIT from run <n> on (counted in FAKE_COUNTER)
//   FAKE_BIND_ERROR=<n>     for the first <n> runs (counted in FAKE_COUNTER), make the
//                           port occupied from a separate process so the real bind fails
//                           and the process exits 0, like the real binary
//   FAKE_IGNORE_TERM=1      ignore SIGTERM
//   FAKE_DELAY_MS=<ms>      wait before listening
//   FAKE_DELAY_AFTER=<n>    only apply FAKE_DELAY_MS from run <n>+1 on
//   FAKE_ECHO=<text>        print <text> on stdout and stderr at startup
//   FAKE_CRLF=1             print a CRLF-terminated line on stdout and stderr
//   FAKE_LONG_LINE=<n>      print one stdout line of <n> 'x' characters, then a short marker line
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const args = process.argv.slice(2);
const configPath = args[args.indexOf('-config') + 1];
const config = parseYaml(readFileSync(configPath, 'utf8'));
const host = config.server?.host || '127.0.0.1';
const port = config.server?.port;

console.log(`fake cpa starting with ${args.join(' ')}`);
console.log(`fake cpa pid ${process.pid}`);
if (process.env.HOME_JWT) console.log(`HOME_JWT length ${process.env.HOME_JWT.length}`);
if (process.env.MANAGEMENT_PASSWORD) console.log(`MANAGEMENT_PASSWORD length ${process.env.MANAGEMENT_PASSWORD.length}`);
if (process.env.FAKE_ECHO) {
  console.log(`stdout: ${process.env.FAKE_ECHO}`);
  console.error(`stderr: ${process.env.FAKE_ECHO}`);
}
if (process.env.FAKE_LONG_LINE) {
  process.stdout.write(`${'x'.repeat(Number(process.env.FAKE_LONG_LINE))}\nafter long line\n`);
}
if (process.env.FAKE_CRLF) {
  process.stdout.write('crlf stdout line\r\n');
  process.stderr.write('crlf stderr line\r\n');
}
const runs = process.env.FAKE_COUNTER && existsSync(process.env.FAKE_COUNTER) ? Number(readFileSync(process.env.FAKE_COUNTER, 'utf8')) + 1 : 1;
if (process.env.FAKE_COUNTER) writeFileSync(process.env.FAKE_COUNTER, String(runs));
const exitAfter = Number(process.env.FAKE_EXIT_AFTER ?? 0);
if (process.env.FAKE_EXIT && (!exitAfter || runs >= exitAfter)) process.exit(Number(process.env.FAKE_EXIT));
if (process.env.FAKE_BIND_ERROR && runs <= Number(process.env.FAKE_BIND_ERROR)) {
  await holdPort(host, port);
}
if (process.env.FAKE_IGNORE_TERM) process.on('SIGTERM', () => console.log('ignoring SIGTERM'));

const delayAfter = Number(process.env.FAKE_DELAY_AFTER ?? 0);
const delayMs = delayAfter && runs <= delayAfter ? 0 : Number(process.env.FAKE_DELAY_MS ?? 0);
setTimeout(() => {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.once('error', (error) => {
    console.error(`fake cpa could not listen on ${host}:${port}: ${error.code}`);
    process.exit(0);
  });
  server.listen(port, host, () => console.log(`API server started successfully on: ${host}:${port}`));
}, delayMs);

function holdPort(host, port) {
  return new Promise((resolve, reject) => {
    const holder = spawn(process.execPath, [fileURLToPath(new URL('./hold-port.mjs', import.meta.url))], {
      env: { ...process.env, HOLD_HOST: host, HOLD_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // On Windows a non-detached child is killed with its parent (libuv job
      // object), and the holder must outlive this process. It exits on its own.
      detached: true,
      windowsHide: true,
    });
    holder.unref();
    holder.once('error', reject);
    holder.once('message', (message) => {
      if (message !== 'listening') return;
      console.log(`fake cpa: port holder ${holder.pid} listening on ${host}:${port}`);
      holder.disconnect();
      resolve();
    });
  });
}
