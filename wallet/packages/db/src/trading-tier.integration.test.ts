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
   * Documents a property of the database that the design depends on NOT having.
   *
   * An overdrawn hold is BALANCED — a debit and a credit of the same amount — so
   * the deferred trigger accepts it and the trading balance goes negative. No
   * constraint refuses it. The sufficient-funds check therefore has to be the
   * SERIALIZABLE read-then-post in the service that takes the hold, exactly as
   * `lockFunds` is for withdrawals. If this test ever starts failing because the
   * commit is refused, a non-negative constraint has been added — good — and
   * this test should be inverted rather than deleted.
   */
  it('does NOT refuse an overdrawn hold, so the service must', async () => {
    const other = newId();
    const entries = [
      entry(other, 'user_trading_available', '500', 'debit'),
      entry(other, 'user_order_locked', '500', 'credit'),
    ];
    await post('order_hold', entries);
    const balances = await ledger.getUserTradingBalances(other, CLUSTER);
    expect(balances.find((b) => b.asset === ASSET)?.available).toBe('-500');
  });
});
