import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    globalSetup: ['tests/setup/launcher.ts'],
    coverage: {
      provider: 'v8',
      // Show line coverage for the client (transport and resources) and the server runtime.
      // Thresholds are deliberately not enforced yet.
      include: ['src/client/**/*.ts', 'src/server/**/*.ts'],
      exclude: ['src/client/types/**'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
