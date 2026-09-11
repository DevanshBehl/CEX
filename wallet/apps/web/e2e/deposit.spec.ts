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
    // Nothing that could be mistaken for money the user does not have.
    expect(visible).not.toMatch(/\$\s?\d/);
    expect(visible).not.toMatch(/[1-9][\d,]*\.\d+\s*SOL/);
  });

  test('activity is empty and says so honestly', async ({ page }) => {
    await register(page);
    await page.goto('/activity');
    await expect(page.getByText(/no activity yet/i)).toBeVisible();
  });

  test('withdrawals are absent and the page says why', async ({ page }) => {
    await register(page);
    // Phase 2 ends with money that can arrive and cannot leave. The UI should
    // say that rather than offering a control that does not work.
    await expect(page.locator('main')).toContainText(/withdrawals are not available yet/i);
  });

  test('a deposit address is not reachable while signed out', async ({ page }) => {
    await page.goto('/deposit');
    await expect(page.getByText(/need to sign in/i)).toBeVisible();
  });
});
