import { defineConfig } from 'vitest/config';

// Runs against a real CLIProxyAPI binary: set CPA_BINARY, or install the platform package.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
