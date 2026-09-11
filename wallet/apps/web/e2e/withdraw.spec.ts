import { expect, test, type Page } from '@playwright/test';
import { addVirtualAuthenticator } from './virtual-authenticator';

/**
 * The withdrawal journey (prompt_phase3.md rules 178, 208).
 *
 * Registration runs the real WebAuthn ceremony via a virtual authenticator, so
 * the step-up prompt a withdrawal triggers is also real — which is the part
 * worth exercising through a browser rather than through `inject`.
 */

async function register(page: Page): Promise<void> {
  await addVirtualAuthenticator(page);
  await page.goto('/register');
  await page.getByRole('button', { name: /create account with a passkey/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe('withdrawal journey', () => {
  test('the withdraw page shows the available balance and a form', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');

    await expect(page.getByRole('heading', { name: 'Withdraw', level: 1 })).toBeVisible();
    await expect(page.getByText(/available/i).first()).toBeVisible();
    await expect(page.getByPlaceholder(/recipient's solana address/i)).toBeVisible();
  });

  test('a new account cannot withdraw what it does not have', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');

    await page
      .getByPlaceholder(/recipient's solana address/i)
      .fill('HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH');
    await page.getByPlaceholder('0.0').fill('1');
    await page.getByRole('button', { name: /request withdrawal/i }).click();

    // Client-side, for the user's benefit. The server refuses it too.
    await expect(page.getByText(/more than your available balance/i)).toBeVisible();
  });

  test('rejects an address that is not a Solana address', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');

    await page.getByPlaceholder(/recipient's solana address/i).fill('not-an-address');
    await page.getByPlaceholder('0.0').fill('0.1');
    await page.getByRole('button', { name: /request withdrawal/i }).click();

    await expect(page.getByText(/does not look like a solana address/i)).toBeVisible();
  });

  test('rejects a zero or negative amount', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');

    await page
      .getByPlaceholder(/recipient's solana address/i)
      .fill('HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH');
    await page.getByPlaceholder('0.0').fill('0');
    await page.getByRole('button', { name: /request withdrawal/i }).click();

    await expect(page.getByText(/greater than zero/i)).toBeVisible();
  });

  test('warns that a sent transaction cannot be reversed', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');
    // The one irreversible action in the product deserves saying so.
    await expect(page.locator('main')).toContainText(/cannot be reversed/i);
  });

  test('tells the user that large withdrawals are reviewed', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');
    await expect(page.locator('main')).toContainText(/reviewed by a person/i);
  });

  test('shows no withdrawals for a new account, and says so honestly', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');
    await expect(page.getByText(/no withdrawals yet/i)).toBeVisible();
  });

  test('the dashboard says signing is still a mock', async ({ page }) => {
    await register(page);
    // master-prompt rule 8: never let anyone assume this is production-safe.
    await expect(page.locator('main')).toContainText(/signing is not real yet/i);
  });

  test('the operator queue is not reachable by an ordinary user', async ({ page }) => {
    await register(page);
    await page.goto('/operator');
    // Reported as not found, never as forbidden — a 403 confirms it exists.
    await expect(page.getByText(/not found/i)).toBeVisible();
  });

  test('withdraw is not reachable while signed out', async ({ page }) => {
    await page.goto('/withdraw');
    await expect(page.getByText(/need to sign in/i)).toBeVisible();
  });
});
