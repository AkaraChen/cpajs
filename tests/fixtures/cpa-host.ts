// e2e host: starts the real CPA (CPA_BINARY) on PORT with default options, so
// cpa-launcher is found next to the binary, prints `cpa <pid>`, and idles.
// No signal handlers: the test kills it with SIGKILL.
import { startServer } from '../../src/server/index.ts';

const server = await startServer({ binaryPath: process.env.CPA_BINARY!, port: Number(process.env.PORT), localModel: true });
console.log(`cpa ${server.pid}`);
setInterval(() => {}, 1_000);
