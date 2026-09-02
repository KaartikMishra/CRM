import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Frontend unit tests.
 *
 * Deliberately narrow: the navigation and module-access helpers are pure
 * functions over plain data, so they need no DOM, no database and no rendering
 * environment. Everything that touches the API or the database is already
 * covered by the backend integration suites, which exercise the real rules.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
