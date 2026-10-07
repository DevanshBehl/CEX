import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLedgerRepository,
  createPrismaClient,
  newId,
  withTransaction,
  type EntryInput,
  type LedgerAccountType,
  type PrismaClient,
} from './index.js';

/**
 * The trading tier against a real PostgreSQL (ADR-0025, ADR-0032).
 *
 * The point of this file is the queries, not the postings. There are eight
 * hand-written `CASE WHEN a.type` arms in the ledger repository, and each is
 * scoped to one tier. A new account type that a query should see and does not
 * is a balance that silently goes missing; one that a query should NOT see and
 * does is a trading balance shown as spendable in the wallet. Only a real
 * database proves which happened.
 */
const APP_URL = process.env.DATABASE_URL;

let db: PrismaClient;
let ledger: ReturnType<typeof createLedgerRepository>;

// A distinct asset per run, so aggregate queries see only this file's rows.
const ASSET = `localnet:TRADE${Date.now().toString(36).toUpperCase()}`;
const CLUSTER = 'localnet' as const;
const user = newId();

beforeAll(async () => {
  if (!APP_URL) throw new Error('DATABASE_URL required');
  db = createPrismaClient({ url: APP_URL });
  ledger = createLedgerRepository(db);
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

function entry(
  ownerId: string | null,
  type: LedgerAccountType,
  amount: string,
  direction: 'debit' | 'credit',
): EntryInput {
  return { account: { ownerId, asset: ASSET, type }, asset: ASSET, amount, direction };
}

async function post(
  kind: Parameters<typeof ledger.postTransaction>[0]['kind'],
  entries: EntryInput[],
) {
  await ledger.ensureAccounts(entries.map((e) => e.account));
  await withTransaction(db, (tx) =>
    ledger.postTransaction({ kind, referenceType: 'test', referenceId: newId(), entries }, tx),
  );
}

describe('the two tiers, as the database sees them', () => {
  beforeAll(async () => {
    // Deposit 10 into the vault.
    await post('deposit', [
      entry(user, 'chain_assets', '10000', 'debit'),
      entry(user, 'user_custody_available', '10000', 'credit'),
    ]);
    // The allocation's withdrawal lock, then the four-leg allocation of 4.
    await post('withdrawal_lock', [
      entry(user, 'user_custody_available', '4000', 'debit'),
      entry(user, 'user_custody_locked', '4000', 'credit'),
    ]);
    await post('allocation', [
      entry(user, 'user_custody_locked', '4000', 'debit'),
      entry(user, 'chain_assets', '4000', 'credit'),
      entry(null, 'clearing_assets', '4000', 'debit'),
      entry(user, 'user_trading_available', '4000', 'credit'),
    ]);
    // A hold of 1 against an order.
    await post('order_hold', [
      entry(user, 'user_trading_available', '1000', 'debit'),
      entry(user, 'user_order_locked', '1000', 'credit'),
    ]);
  });

  it('the wallet balance is the vault tier only', async () => {
    const balance = await ledger.getUserBalance(user, ASSET);
    // 10 deposited, 4 allocated away. The trading balance is NOT here: it sits
    // at the clearing address, not the user's own, and showing it as spendable
    // in the wallet would be showing money the wallet cannot send.
    expect(balance).toMatchObject({ available: '6000', locked: '0', total: '6000' });
  });

  it('the trading balance is the clearing tier only', async () => {
    const balances = await ledger.getUserTradingBalances(user, CLUSTER);
    const mine = balances.find((b) => b.asset === ASSET);
    expect(mine).toMatchObject({ available: '3000', locked: '1000', total: '4000' });
  });

  it('the clearing equation balances: clearing assets cover trading liabilities', async () => {
    const totals = await ledger.getClearingTotals(CLUSTER);
    const row = totals.find((t) => t.asset === ASSET);
    expect(row).toMatchObject({ tradingLiabilities: '4000', clearingAssets: '4000' });
  });

  it('the vault equation still balances per owner, excluding the trading tier', async () => {
    const positions = await ledger.getSegregatedPositions(CLUSTER);
    const mine = positions.find((p) => p.asset === ASSET && p.ownerId === user);
    // If trading liabilities leaked into this query, liability would read 10
    // against chain assets of 6 — a false per-user shortfall on every trader.
    expect(mine).toBeDefined();
    expect(mine?.chainAssets).toBe('6000');
    expect(mine?.liability).toBe('6000');
  });

  /**
   * Inverted in S4, as its S3 version asked to be (ADR-0034 §7).
   *
   * An overdrawn hold is BALANCED — a debit and a credit of the same amount —
   * so the per-asset trigger accepts it. Until S4 nothing else did refuse it,
   * and the trading balance went negative. A deferred trigger now refuses to
   * commit any transaction that leaves a user trading account below zero. The
   * service's SERIALIZABLE read-then-post is still the primary check; this is
   * what turns a bug in it into a refused commit.
   */
  it('refuses an overdrawn hold at commit', async () => {
    const other = newId();
    const entries = [
      entry(other, 'user_trading_available', '500', 'debit'),
      entry(other, 'user_order_locked', '500', 'credit'),
    ];
    await expect(post('order_hold', entries)).rejects.toThrow(/would leave trading account/);
    const balances = await ledger.getUserTradingBalances(other, CLUSTER);
    expect(balances.find((b) => b.asset === ASSET)?.available ?? '0').toBe('0');
  });

  it('judges the FINAL state, so funding and a hold in one transaction commit', async () => {
    const other = newId();
    // The hold's debit is checked against the balance at COMMIT, which
    // includes the credit that funds it — whatever order the entries were
    // inserted in.
    await post('allocation', [
      entry(null, 'clearing_assets', '500', 'debit'),
      entry(other, 'user_trading_available', '500', 'credit'),
      entry(other, 'user_trading_available', '500', 'debit'),
      entry(other, 'user_order_locked', '500', 'credit'),
    ]);
    const balances = await ledger.getUserTradingBalances(other, CLUSTER);
    expect(balances.find((b) => b.asset === ASSET)?.locked).toBe('500');
  });
});
