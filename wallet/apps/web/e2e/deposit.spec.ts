import { expect, test } from '@playwright/test';
import { addVirtualAuthenticator } from './virtual-authenticator';

/**
 * The deposit journey (prompt_phase2.md rules 189, 207).
 *
 * Registration goes through the real WebAuthn ceremony via a virtual
 * authenticator, exactly as in the Phase 1 suite.
 */

async function register(page: import('@playwright/test').Page): Promise<void> {
  await addVirtualAuthenticator(page);
  await page.goto('/register');
  await page.getByRole('button', { name: /create account with a passkey/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe('deposit journey', () => {
  test('a new user can obtain a deposit address', async ({ page }) => {
    await register(page);

    await page.goto('/deposit');
    const address = page.getByTestId('deposit-address');
    await expect(address).toBeVisible();

    const value = (await address.textContent())?.trim() ?? '';
    // A base58 Solana address: 32-44 chars, no 0/O/I/l.
    expect(value).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  test('the same user always gets the same address (rule 143)', async ({ page }) => {
    await register(page);

    await page.goto('/deposit');
    const first = (await page.getByTestId('deposit-address').textContent())?.trim();

    await page.reload();
    const second = (await page.getByTestId('deposit-address').textContent())?.trim();

    expect(second).toBe(first);
  });

  test('the asset and network are stated unambiguously (rule 172)', async ({ page }) => {
    await register(page);
    await page.goto('/deposit');

    const main = page.locator('main');
    await expect(main).toContainText('SOL');
    // The warning has to be present and specific, not merely implied.
    await expect(main).toContainText(/only/i);
    await expect(main).toContainText(/permanently lost/i);
  });

  test('a new account shows a zero balance, not a fabricated one (rule 176)', async ({ page }) => {
    await register(page);

    const main = page.locator('main');
    await expect(main).toContainText(/balances/i);

    const visible = await main.innerText();
    // Nothing that could be mistaken for money the user does not have. `$0.00`
    // is allowed: an empty portfolio IS worth nothing, and the valuation card
    // says so rather than inventing a figure (Task 3).
    expect(visible).not.toMatch(/\$\s?(?!0\.00\b)[\d,]*[1-9][\d,]*(\.\d+)?/);
    expect(visible).not.toMatch(/[1-9][\d,]*\.\d+\s*SOL/);
  });

  test('activity is empty and says so honestly', async ({ page }) => {
    await register(page);
    await page.goto('/activity');
    await expect(page.getByText(/no activity yet/i)).toBeVisible();
  });

  test('the dashboard is honest about what is not real yet', async ({ page }) => {
    await register(page);

    /**
     * The PROPERTY, not the wording.
     *
     * Phase 2 asserted "withdrawals are not available yet". Phase 3 built them
     * and the wording changed. Phase 4 shipped a real signing service and it
     * changed again — and each time, a test pinned to the exact sentence
     * failed for the wrong reason: not because the UI became dishonest, but
     * because it became more accurate.
     *
     * What must hold is that the page states the limitation plainly and never
     * overstates it (master-prompt rule 8).
     */
    const main = page.locator('main');
    await expect(main).toContainText(/signing is (not real yet|real, and it is a single key)/i);
    await expect(main).toContainText(/mock|not been audited|not yet threshold/i);
    await expect(main).not.toContainText(/production[- ]safe|fully audited/i);
  });

  test('a deposit address is not reachable while signed out', async ({ page }) => {
    await page.goto('/deposit');
    await expect(page.getByText(/need to sign in/i)).toBeVisible();
  });
});
