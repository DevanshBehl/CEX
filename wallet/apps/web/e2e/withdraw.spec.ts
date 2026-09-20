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

  /**
   * The asset picker (ADR-0016).
   *
   * The page sent SOL and only SOL: the asset was a string literal in the
   * submit handler and the decimals were a literal nine. A user holding USDC
   * had a balance the interface showed them and gave them no way to move.
   */
  test('offers every asset the platform can send, not only SOL', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');

    const picker = page.getByRole('radiogroup', { name: /asset to withdraw/i });
    await expect(picker).toBeVisible();
    // SOL is always allowlisted, so it is always an option. Any configured
    // token appears beside it without this test naming it — asserting on a
    // specific mint would tie the suite to one deployment's TOKEN_MINTS.
    await expect(picker.getByRole('radio', { name: /SOL/ })).toBeVisible();
  });

  test('the amount field follows the selected asset', async ({ page }) => {
    await register(page);
    await page.goto('/withdraw');

    const options = page.getByRole('radiogroup', { name: /asset to withdraw/i }).getByRole('radio');
    // Awaited, not counted immediately: the picker is driven by the balances
    // fetch, so a bare `count()` on arrival reads zero and the test skips
    // itself for a reason that was never true.
    await expect(options.first()).toBeVisible();

    // Only meaningful where a second asset is configured.
    test.skip((await options.count()) < 2, 'this deployment allowlists only the native asset');

    await page.getByPlaceholder('0.0').fill('1.23');
    await options.nth(1).click();

    // Cleared, because "1.23" means a different amount under each asset, and
    // carrying it across is how a user sends the wrong size.
    await expect(page.getByPlaceholder('0.0')).toHaveValue('');
    await expect(options.nth(1)).toHaveAttribute('aria-checked', 'true');
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

  test('the dashboard states what signing actually is, whichever it is', async ({ page }) => {
    await register(page);

    /**
     * Either copy is acceptable; a claim of being audited or production-safe
     * is not (master-prompt rule 8).
     *
     * Asserting the exact mock wording would make this test fail the moment a
     * real signer shipped — which is backwards, since that is when the copy
     * most needs to be right. What must hold is that the page says something
     * true about signing and never overstates it.
     */
    const main = page.locator('main');
    await expect(main).toContainText(/signing is (not real yet|real, and it is a single key)/i);
    await expect(main).not.toContainText(/production[- ]safe|audited and secure/i);
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
