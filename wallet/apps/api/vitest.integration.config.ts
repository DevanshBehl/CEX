import { defineConfig } from 'vitest/config';

/**
 * Test-only overrides for limits that are production concerns, not test ones.
 *
 * The rate limit exists to bound a compromised session; a suite making
 * hundreds of submissions from one IP is not that. The worker batch size caps
 * how much a cycle processes — sensible in production, and in a suite it means
 * withdrawals left in flight by earlier tests crowd out the one under test, so
 * a cycle appears to do nothing.
 */
// Set, not defaulted: `.env` carries the production values and would win over
// a `??=`. Rate-limit state also lives in Redis and persists between runs, so a
// realistic limit makes the suite fail depending on what ran before it.
process.env.RATE_LIMIT_WITHDRAWAL_PER_MINUTE = '1000000';
process.env.WITHDRAWAL_WORKER_BATCH_SIZE = '100';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
