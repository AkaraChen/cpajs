import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Show line coverage for the hand-written API resources and the server runtime.
      // Thresholds are deliberately not enforced yet.
      include: ['src/client/resources/**/*.ts', 'src/server/**/*.ts'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
