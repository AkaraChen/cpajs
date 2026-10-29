import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Runs against a real CLIProxyAPI binary: set CPA_BINARY. No traffic goes to OpenAI.
export default defineConfig({
  resolve: {
    alias: {
      '@cpajs/cpa/server': fileURLToPath(new URL('../cpa/src/server/index.ts', import.meta.url)),
      '@cpajs/cpa': fileURLToPath(new URL('../cpa/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
