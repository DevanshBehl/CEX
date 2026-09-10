import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // apps/api has no unit tests by design: its logic is either delegated to
    // packages (which have their own suites) or is HTTP wiring, which is only
    // meaningfully testable against a real server and a real database. See
    // test/api.integration.test.ts, run by `pnpm test:integration`.
    passWithNoTests: true,
  },
});
