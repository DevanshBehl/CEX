import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests need a real PostgreSQL (rule 190) and are run by the
    // separate `test:integration` script.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
