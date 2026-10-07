import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import { trading } from './trading-env';
import { addVirtualAuthenticator } from './virtual-authenticator';

/**
 * The trading screen, in a browser, against the real matching engine
 * (prompt_phase_s5.md rules 222-224).
 *
 * Everything below the browser is real: the engine binary, its Redis stream,
 * settlement, the trade tape, the fan-out and the socket. Two people in two
 * browser contexts trade with each other, and each sees what the system knows
 * about them — and nothing it does not.
 *
 * WHAT IT DOES NOT COVER: the chain. Trading balances are credited in the
 * ledger by a test-only script, because a real allocation needs a validator
 * and a signer that can actually sign, and this suite runs the mock signer.
 * The transfer panel is exercised as far as its form; the on-chain leg, and
 * reconciliation check 1 against a real chain, are not proven here.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { symbol, quoteSymbol, quoteMint } = trading;

// Locally, a skip — and it says why. In CI, a failure: a suite that is green
// for having skipped the trading journey proves nothing about the screen.
if (!trading.available && process.env.CI) {
  throw new Error('the matching engine is not built, and CI must not skip the trading journey');
}
test.skip(
  !trading.available,
  'the matching engine is not built: run `pnpm build:rust` to include the trading journey',
);

async function register(page: Page): Promise<string> {
  await addVirtualAuthenticator(page);
  await page.goto('/register');
  await page.getByRole('button', { name: /create account with a passkey/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  const me = (await (await page.request.get(`${API}/me`)).json()) as { user: { id: string } };
  return me.user.id;
}

/** A trading balance, without a chain. Test-only: see `credit-trading-cli.ts`. */
function credit(userId: string, asset: string, baseUnits: string): void {
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@wallet/api',
      'exec',
      'tsx',
      'test/credit-trading-cli.ts',
      userId,
      asset,
      baseUnits,
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
}

async function trader(context: BrowserContext, funds: { sol?: string; quote?: string }) {
  const page = await context.newPage();
  const userId = await register(page);
  if (funds.sol) credit(userId, 'SOL', funds.sol);
  if (funds.quote) credit(userId, quoteMint, funds.quote);
  return { page, userId };
}

async function openMarket(page: Page): Promise<void> {
  await page.goto(`/trade/${symbol}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('SOL');
}

const form = (page: Page) => page.getByRole('region', { name: 'Place an order' });
const book = (page: Page) => page.getByRole('region', { name: 'Order book' });
const orders = (page: Page) => page.getByRole('region', { name: 'Your orders' });

async function fill(page: Page, order: { side: 'buy' | 'sell'; price: string; qty: string }) {
  await form(page)
    .getByRole('group', { name: 'Side' })
    .getByRole('button', { name: order.side === 'buy' ? 'Buy SOL' : 'Sell SOL' })
    .click();
  await form(page)
    .getByLabel(/^Price/)
    .fill(order.price);
  await form(page)
    .getByLabel(/^Quantity/)
    .fill(order.qty);
}

const submit = (page: Page) => form(page).locator('button[type="submit"]');

async function openOrders(page: Page): Promise<Array<{ price: string; status: string }>> {
  const response = await page.request.get(`${API}/orders?market=${symbol}&status=open`);
  return ((await response.json()) as { orders: Array<{ price: string; status: string }> }).orders;
}

test.describe('trading journey', () => {
  test('two people trade: the book, the tape, the fill and both balances', async ({ browser }) => {
    const sellerContext = await browser.newContext();
    const buyerContext = await browser.newContext();
    const seller = await trader(sellerContext, { sol: '5000000000' });
    const buyer = await trader(buyerContext, { quote: '1000000000' });

    // --- the seller rests an order, and it is in the book ---
    await openMarket(seller.page);
    // Asked of the deployment, not assumed: nothing here quotes for a program.
    await expect(seller.page.getByText(/synthetic liquidity/i)).toHaveCount(0);
    await fill(seller.page, { side: 'sell', price: '150', qty: '1' });
    // A sell reserves the quantity itself.
    await expect(seller.page.getByTestId('hold-amount')).toHaveText('1 SOL');
    await submit(seller.page).click();

    await expect(orders(seller.page).getByTestId('orders-table')).toContainText('Open');
    await expect(book(seller.page).getByTestId('book-levels')).toHaveAttribute('data-live', 'true');
    await expect(book(seller.page).getByTestId('book-levels')).toContainText('150.00');

    // --- the buyer sees the same book, live ---
    await openMarket(buyer.page);
    await expect(book(buyer.page).getByText('Live', { exact: true })).toBeVisible();
    await expect(book(buyer.page).getByTestId('book-levels')).toContainText('150.00');
    await expect(buyer.page.getByTestId('last-price')).toHaveText('No trades yet');

    // Picking a level from the book fills the price — as text, never a float.
    await book(buyer.page).getByTitle('Use this price').first().click();
    await expect(form(buyer.page).getByLabel(/^Price/)).toHaveValue('150');
    await form(buyer.page)
      .getByLabel(/^Quantity/)
      .fill('1');
    // The gateway's own hold: the notional plus the worst-case fee.
    await expect(buyer.page.getByTestId('hold-amount')).toHaveText(`150.30 ${quoteSymbol}`);
    await submit(buyer.page).click();

    // --- the trade is public, on both screens ---
    for (const page of [buyer.page, seller.page]) {
      await expect(page.getByTestId('trade-tape')).toContainText('150.00');
      await expect(page.getByTestId('last-price')).toHaveText('150.00');
    }
    // The level is gone from the book: zero means removed, not shown at zero.
    await expect(book(buyer.page).getByTestId('book-levels')).not.toContainText('150.00');

    // --- each sees their OWN fill, once the ledger has it ---
    await orders(buyer.page).getByRole('tab', { name: 'Your fills' }).click();
    const buyerFills = orders(buyer.page).getByTestId('fills-table');
    await expect(buyerFills).toContainText('buy · taker');
    // The recorded rate and amount: 20 bp of 150.
    await expect(buyerFills).toContainText('0.3000');
    await expect(buyerFills).toContainText('(20 bp)');

    await orders(seller.page).getByRole('tab', { name: 'Your fills' }).click();
    const sellerFills = orders(seller.page).getByTestId('fills-table');
    await expect(sellerFills).toContainText('sell · maker');
    await expect(sellerFills).toContainText('(10 bp)');
    // Neither is shown the other's side of it.
    await expect(sellerFills).not.toContainText('taker');
    await expect(buyerFills).not.toContainText('maker');

    await orders(seller.page).getByRole('tab', { name: 'Order history' }).click();
    await expect(orders(seller.page).getByTestId('orders-table')).toContainText('Filled');

    // --- and both balances are the ledger's, fetched ---
    // The buyer paid 150 plus a 0.30 fee; the hold was consumed exactly.
    await expect(buyer.page.getByTestId('trading-available')).toHaveText(`849.7 ${quoteSymbol}`);
    // The seller received 150 less the 0.15 maker fee.
    await expect(seller.page.getByTestId('trading-available')).toHaveText(`149.85 ${quoteSymbol}`);

    await sellerContext.close();
    await buyerContext.close();
  });

  test('a double-clicked submit is one order with one hold', async ({ browser }) => {
    const context = await browser.newContext();
    const { page } = await trader(context, { quote: '1000000000' });
    await openMarket(page);
    await fill(page, { side: 'buy', price: '140', qty: '1' });
    await submit(page).dblclick();

    await expect(orders(page).getByTestId('orders-table')).toContainText('Open');
    await expect.poll(async () => (await openOrders(page)).length).toBe(1);
    // One hold: 140 plus 20 bp. A second order would have taken a second.
    await expect(page.getByTestId('trading-available')).toHaveText(`859.72 ${quoteSymbol}`);
    await context.close();
  });

  test('a rejected order says why before it is sent, and takes no hold', async ({ browser }) => {
    const context = await browser.newContext();
    const { page } = await trader(context, { quote: '1000000000' });
    await openMarket(page);

    // Off the tick, and more decimals than the asset has.
    await fill(page, { side: 'buy', price: '140.001', qty: '1' });
    await submit(page).click();
    await expect(form(page).getByRole('alert')).toContainText(/tick/i);

    await fill(page, { side: 'buy', price: '140', qty: '1.0000000001' });
    await submit(page).click();
    await expect(form(page).getByRole('alert')).toContainText(/more decimal places/i);

    // More than the balance: refused here, and the server would refuse it too.
    await fill(page, { side: 'buy', price: '140', qty: '100' });
    await submit(page).click();
    await expect(form(page).getByRole('alert')).toContainText(/more than your available/i);

    expect(await openOrders(page)).toEqual([]);
    await expect(page.getByTestId('trading-available')).toHaveText(`1,000 ${quoteSymbol}`);
    await context.close();
  });

  test('a dropped socket marks the book stale, then recovers with the server’s book', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const { page } = await trader(context, { quote: '1000000000' });

    // Every socket the page opens passes through here, so the test can cut it.
    const sockets: WebSocketRoute[] = [];
    let down = false;
    await page.routeWebSocket(/\/ws$/, (route) => {
      if (down) {
        void route.close();
        return;
      }
      route.connectToServer();
      sockets.push(route);
    });

    await openMarket(page);
    const levels = book(page).getByTestId('book-levels');
    await expect(levels).toHaveAttribute('data-live', 'true');

    down = true;
    for (const socket of sockets.splice(0)) await socket.close();

    // Shown as stale — not hidden, and not shown as live.
    await expect(book(page).getByText(/reconnecting — stale/i)).toBeVisible();
    await expect(levels).toHaveAttribute('data-live', 'false');
    await expect(page.getByText(/the book and the tape below are not current/i)).toBeVisible();

    // The order form still works: orders go over REST, not the socket.
    await fill(page, { side: 'buy', price: '130', qty: '1' });
    await submit(page).click();
    await expect.poll(async () => (await openOrders(page)).length).toBe(1);

    down = false;
    // It reconnects on its own, resubscribes, and is handed a fresh snapshot —
    // which includes the order placed while it was not listening.
    await expect(levels).toHaveAttribute('data-live', 'true', { timeout: 30_000 });
    await expect(levels).toContainText('130.00');
    await expect(orders(page).getByTestId('orders-table')).toContainText('Open');
    await context.close();
  });

  test('wallet and trading are shown as two balances, and a transfer needs funds to move', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const { page } = await trader(context, { quote: '1000000000' });
    await openMarket(page);
    const transfer = page.getByRole('region', { name: 'Move funds' });

    await expect(transfer.getByText('Wallet — at your own address')).toBeVisible();
    await expect(transfer.getByText('Trading — a claim on the clearing pool')).toBeVisible();
    // Said for what it is: an on-chain transfer that takes as long as one.
    await expect(
      transfer.getByText(/on-chain transfer, confirmed with your passkey/i),
    ).toBeVisible();

    // Nothing in the wallet: refused before any passkey prompt.
    await transfer.getByLabel('Amount').fill('5');
    await transfer.getByRole('button', { name: 'Move to trading' }).click();
    await expect(transfer.getByRole('alert')).toContainText(/more than is available to move/i);
    await context.close();
  });

  test('the market list links to the market, and trading is in the navigation', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const { page } = await trader(context, {});
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Trade' }).click();
    await expect(page).toHaveURL(/\/trade$/);
    await page.getByRole('link', { name: new RegExp(`SOL\\s*/\\s*${quoteSymbol}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/trade/${symbol}$`));
    await context.close();
  });
});
