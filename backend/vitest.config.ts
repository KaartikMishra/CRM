import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests exercise the real Express app against the real Neon database, so
    // they are integration tests: a generous timeout absorbs Neon's cold start,
    // and files run in sequence because they share one database.
    // Wakes Neon once before the run, so no suite pays the cold start.
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ['default'],
  },
});
