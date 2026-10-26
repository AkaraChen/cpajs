#!/usr/bin/env node
// Holds a TCP port after the fake CPA process exits, so the port is still
// occupied when startServer re-probes it.
import { createServer } from 'node:net';

const host = process.env.HOLD_HOST || '127.0.0.1';
const port = Number(process.env.HOLD_PORT);

const server = createServer();
server.once('error', () => process.exit(1));
server.listen(port, host, () => process.send?.('listening'));

process.on('disconnect', () => setTimeout(() => process.exit(0), 2_000));
setTimeout(() => process.exit(0), 15_000).unref();
