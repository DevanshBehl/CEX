import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end journeys (prompt_phase1.md rule 191).
 *
 * Chromium only, deliberately: these tests drive a CDP *virtual authenticator*,
 * which is the only way to exercise a real WebAuthn ceremony without a human
 * touching a hardware key. That API is Chromium-specific. Cross-browser
 * coverage of the non-ceremony UI is worth adding later; a green suite that
 * skipped the ceremony entirely would be worth much less.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  timeout: 60_000,

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // `channel: 'chromium'` runs the full Chromium build in headless mode
        // rather than the separate headless-shell download. The shell is a
        // smaller artifact but an extra thing to fetch, and the WebAuthn CDP
        // domain these tests depend on behaves identically in both.
        channel: 'chromium',
      },
    },
  ],

  webServer: [
    {
      command: 'pnpm --filter @wallet/api dev',
      /**
       * Rate limits raised for the suite.
       *
       * Two dozen browser journeys from one IP exceed a realistic per-minute
       * ceiling, `/auth/session` gets throttled, and the app correctly decides
       * the user is signed out — which surfaces as unrelated assertions failing
       * on pages that are working fine.
       */
      env: {
        ...process.env,
        RATE_LIMIT_GLOBAL_PER_MINUTE: '100000',
        RATE_LIMIT_WITHDRAWAL_PER_MINUTE: '100000',
        RATE_LIMIT_AUTH_PER_IP_PER_MINUTE: '100000',
      },
      url: 'http://localhost:4000/health/live',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '../..',
    },
    {
      command: 'pnpm --filter @wallet/web dev',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '../..',
    },
  ],
});
