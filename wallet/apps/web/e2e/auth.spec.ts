import { expect, test } from '@playwright/test';
import { addVirtualAuthenticator } from './virtual-authenticator';

/**
 * The Phase 1 Definition-of-Done journeys (prompt_phase1.md rules 168-173, 191).
 *
 * Each test below corresponds to a checkbox in §12 of the prompt. They drive
 * the real UI against the real API against real PostgreSQL, with a virtual
 * authenticator standing in for the user's finger.
 */

test.describe('passkey journeys', () => {
  test('register, sign out, sign back in (rules 168-169)', async ({ page }) => {
    const authenticator = await addVirtualAuthenticator(page);

    // --- Register ---
    await page.goto('/register');
    await page.getByPlaceholder('you@example.com').fill(`e2e-${Date.now()}@example.test`);
    await page.getByPlaceholder('Your name').fill('E2E User');
    await page.getByRole('button', { name: /create account with a passkey/i }).click();

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    expect(await authenticator.credentialCount()).toBe(1);

    // --- Sign out ---
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    // --- Sign back in, with no identifier typed (discoverable credential) ---
    await page.getByRole('button', { name: /sign in with a passkey/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('the session survives a page reload (rule 170)', async ({ page }) => {
    await addVirtualAuthenticator(page);
    await page.goto('/register');
    await page.getByRole('button', { name: /create account with a passkey/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // And on a fresh navigation, since the cookie is httpOnly and the client
    // holds nothing of its own.
    await page.goto('/security');
    await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
  });

  test('a second passkey can be added and both are listed (rule 172)', async ({ page }) => {
    const authenticator = await addVirtualAuthenticator(page);
    await page.goto('/register');
    await page.getByRole('button', { name: /create account with a passkey/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto('/security');
    await page.getByRole('button', { name: /add a passkey/i }).click();

    await expect.poll(async () => authenticator.credentialCount(), { timeout: 15_000 }).toBe(2);
  });

  test('revoking a session signs that device out (rule 171)', async ({ page }) => {
    await addVirtualAuthenticator(page);
    await page.goto('/register');
    await page.getByRole('button', { name: /create account with a passkey/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto('/security');

    // Everything here is scoped to the sessions card. The header carries its
    // own "Sign out" button, and the passkey added at registration is also
    // labelled "This device" — unscoped selectors match both.
    const sessionsCard = page.locator('section').filter({ hasText: 'Active sessions' });
    await expect(sessionsCard.getByText('This device')).toBeVisible();

    await sessionsCard.getByRole('button', { name: 'Sign out', exact: true }).first().click();
    await expect(page).toHaveURL(/\/login/);

    // The cookie is dead server-side, not merely cleared client-side.
    await page.goto('/dashboard');
    await expect(page.getByText(/need to sign in/i)).toBeVisible();
  });
});

test.describe('security properties visible from the browser', () => {
  test('the session cookie is httpOnly and not readable from JavaScript (rules 124, 165)', async ({
    page,
  }) => {
    await addVirtualAuthenticator(page);
    await page.goto('/register');
    await page.getByRole('button', { name: /create account with a passkey/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'wallet_session');
    expect(session, 'session cookie was not set').toBeDefined();
    expect(session!.httpOnly).toBe(true);
    expect(session!.sameSite).toBe('Strict');

    // Nothing readable from the page, anywhere.
    const visible = await page.evaluate(() => ({
      cookie: document.cookie,
      local: JSON.stringify(window.localStorage),
      sessionStorage: JSON.stringify(window.sessionStorage),
    }));
    expect(visible.cookie).not.toContain(session!.value);
    expect(visible.local).not.toContain(session!.value);
    expect(visible.sessionStorage).not.toContain(session!.value);
  });

  test('a protected page is not reachable while signed out', async ({ page }) => {
    for (const path of ['/dashboard', '/security', '/profile', '/wallet', '/activity']) {
      await page.goto(path);
      await expect(page.getByText(/need to sign in/i), path).toBeVisible();
    }
  });

  test('a new account shows nothing it does not have (rules 156-157)', async ({ page }) => {
    // Phase 1 asserted "no balances yet", because there was no ledger. Phase 2
    // shows real balances, so the wording changed — but the property under
    // test did not: a new account must never display a number it does not own.
    await addVirtualAuthenticator(page);
    await page.goto('/register');
    await page.getByRole('button', { name: /create account with a passkey/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // innerText of <main>, not textContent of <body>: textContent includes the
    // contents of <script> tags, and Next.js inlines its RSC payload there —
    // which is full of numbers the user never sees.
    const visible = await page.locator('main').innerText();
    expect(visible, 'a currency amount is being displayed').not.toMatch(/\$\s?\d/);
    expect(visible, 'a token amount is being displayed').not.toMatch(/\d+\.\d{2,}\s*(SOL|USDC)/i);
  });
});
