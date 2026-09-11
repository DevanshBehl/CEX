import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Localnet tests need a validator and are run by `test:integration`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
