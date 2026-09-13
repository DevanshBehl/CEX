import { expect, test } from '@playwright/test';
import { addVirtualAuthenticator } from './virtual-authenticator';

/**
 * The network indicator, in a real browser (ADR-0021).
 *
 * # Why this needs a browser at all
 *
 * The cluster travels as `X-Solana-Cluster`, which is a CUSTOM header — so
 * every request becomes a preflighted one, and a header missing from the API's
 * CORS allowlist fails the preflight and the browser blocks the request
 * entirely. Nothing server-side notices: every integration test injects into
 * Fastify directly and never crosses an origin.
 *
 * That is exactly what happened when this shipped, and it is what these tests
 * exist to catch. A page that renders its balances at all is proof the header
 * survived the round trip.
 */
async function register(page: import('@playwright/test').Page): Promise<void> {
  await addVirtualAuthenticator(page);
  await page.goto('/register');
  await page.getByRole('button', { name: /create account with a passkey/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe('the network indicator', () => {
  test('names the cluster the deployment actually serves', async ({ page }) => {
    await register(page);

    const pill = page.getByTestId('network-pill');
    await expect(pill).toBeVisible();

    // Whatever this deployment serves — the assertion is that it is NAMED,
    // not that it is any particular one.
    const cluster = await pill.getAttribute('data-cluster');
    expect(['localnet', 'devnet', 'testnet', 'mainnet-beta']).toContain(cluster);
  });

  test('is visible before signing in, because it is chosen before signing in', async ({ page }) => {
    // The switcher is populated from the unauthenticated /capabilities, so
    // someone deciding whether to trust a custodian can see it is a devnet
    // deployment without depositing first.
    await page.goto('/login');
    await expect(page.getByTestId('network-pill')).toBeVisible();
  });

  test('DATA STILL LOADS with the cluster header attached', async ({ page }) => {
    /*
     * The CORS regression in one assertion.
     *
     * If `x-solana-cluster` were not on the API's allowed-headers list, the
     * preflight would fail, every call would be blocked, and the dashboard
     * would render its error state instead of a balance.
     */
    await register(page);

    const main = page.locator('main');
    await expect(main).toContainText(/balances/i);
    await expect(main).not.toContainText(/could not reach the server/i);
  });

  test('shows a test cluster as a test cluster on the deposit page', async ({ page }) => {
    await register(page);
    await page.goto('/deposit');

    const pill = page.getByTestId('network-pill');
    const cluster = await pill.getAttribute('data-cluster');

    // The faucet panel appears on a test cluster and MUST NOT on mainnet:
    // there is no faucet to offer, and a greyed-out button would be an
    // invitation to look for one.
    const faucet = page.getByTestId('faucet-panel');
    if (cluster === 'mainnet-beta') {
      await expect(faucet).toHaveCount(0);
    } else {
      await expect(faucet).toBeVisible();
      await expect(faucet).toContainText(/no value/i);
    }
  });
});

test.describe('switching networks', () => {
  /**
   * Only meaningful where more than one cluster is served.
   *
   * Skipped rather than faked on a single-cluster deployment: a test that
   * stubbed `/capabilities` would be testing the stub. Run the API with
   * `SOLANA_CLUSTERS=localnet,devnet` to exercise this.
   */
  test('changes the pill and reloads the data for the new cluster', async ({ page }) => {
    await register(page);

    const switcher = page.getByTestId('network-switcher');
    test.skip((await switcher.count()) === 0, 'this deployment serves one cluster');

    const before = await page.getByTestId('network-pill').getAttribute('data-cluster');

    await switcher.click();
    const options = page.getByRole('option');
    await expect(options.first()).toBeVisible();

    // The option that is NOT the current cluster.
    const other = options.filter({ hasNotText: new RegExp(before ?? '', 'i') }).first();
    await other.click();

    const after = await page.getByTestId('network-pill').getAttribute('data-cluster');
    expect(after).not.toBe(before);

    // The page must still be able to talk to the server on the new cluster.
    await expect(page.locator('main')).not.toContainText(/could not reach the server/i);

    // And the choice survives a reload, which is the whole point of storing it.
    await page.reload();
    await expect(page.getByTestId('network-pill')).toHaveAttribute('data-cluster', after ?? '');
  });
});
