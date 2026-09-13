import { expect, test } from '@playwright/test';
import { addVirtualAuthenticator } from './virtual-authenticator';

/**
 * The portfolio surface, in a real browser (Task 4).
 *
 * A new account genuinely has nothing and nothing is priced for it, so what is
 * checked here is that the interface says so HONESTLY — the empty state, the
 * range toggles, and the absence of a fabricated $0.00 where a price is
 * unknown. The priced path is covered by the API integration suite, which can
 * write a tick at a chosen instant and assert an exact figure.
 */
async function register(page: import('@playwright/test').Page): Promise<void> {
  await addVirtualAuthenticator(page);
  await page.goto('/register');
  await page.getByRole('button', { name: /create account with a passkey/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe('the portfolio chart', () => {
  test('renders with every range toggle', async ({ page }) => {
    await register(page);

    const chart = page.getByTestId('portfolio-chart');
    await expect(chart).toBeVisible();

    for (const range of ['24h', '7d', '30d', 'all']) {
      await expect(page.getByTestId(`range-${range}`)).toBeVisible();
    }
  });

  test('switching a range does not break the page', async ({ page }) => {
    await register(page);

    await page.getByTestId('range-7d').click();
    await expect(page.getByTestId('range-7d')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('portfolio-chart')).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/could not reach the server/i);
  });

  test('says it has nothing to chart rather than drawing a flat zero', async ({ page }) => {
    // A line at zero implies we have been watching this account fall. It has
    // simply never held anything.
    await register(page);
    await expect(page.getByTestId('portfolio-chart')).toContainText(/nothing to chart yet/i);
  });
});

test.describe('the holdings table', () => {
  test('is present and empty for a new account', async ({ page }) => {
    await register(page);

    const breakdown = page.getByTestId('asset-breakdown');
    await expect(breakdown).toBeVisible();
    await expect(breakdown).toContainText(/nothing held on this network yet/i);
  });

  test('states that funds are held at the user’s own address', async ({ page }) => {
    // The claim segregated custody makes (ADR-0020), said where someone will
    // read it rather than only in a document.
    await register(page);
    await expect(page.getByTestId('asset-breakdown')).toContainText(/your own address/i);
  });
});

test.describe('the dashboard headline', () => {
  test('shows a portfolio value card rather than a fabricated number', async ({ page }) => {
    await register(page);

    const main = page.locator('main');
    await expect(main).toContainText(/portfolio value/i);
    // With no holdings and no prices, the honest answers are a dash or $0.00 —
    // never a number that implies a valuation nobody can reproduce.
    await expect(main).not.toContainText(/NaN|undefined|Infinity/);
  });
});
