import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAssetRegistry } from '@wallet/types';
import { createLedgerRepository, withTransaction } from '@wallet/db';
import { toBaseUnits } from '@wallet/ledger';
import { createSweepService } from '../src/services/sweep.service.js';
import {
  creditUser,
  fundHouse,
  seedSession,
  SOL_KEY,
  startHarness,
  TEST_CHAIN,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';

/**
 * Sweeps (ADR-0017, prompt_phase4.md rules 128-133).
 *
 * The property under test is an ACCOUNTING one, not a mechanical one: a sweep
 * moves money between two addresses the platform already controls, so the only
 * thing that may change in the ledger is the fee.
 */

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.cleanup();
});

const RENT = '890880';

/** A chain reader with balances we control. */
function reader(balances: Record<string, string>) {
  return {
    chain: TEST_CHAIN,
    validator: { isValid: () => true, isSignable: () => true } as never,
    async getBalance(address: string) {
      return balances[address] ?? '0';
    },
    async getMinimumAccountBalance() {
      return RENT;
    },
    async getConfirmation() {
      return 'final' as const;
    },
    async getPosition() {
      return 0n;
    },
    async accountExists() {
      return true;
    },
    async isHealthy() {
      return true;
    },
  };
}

function service(balances: Record<string, string>, threshold = '1000000') {
  return createSweepService({
    db: h.app.appDeps.db,
    reader: reader(balances) as never,
    chain: TEST_CHAIN,
    assets: createAssetRegistry({ cluster: TEST_CLUSTER, nativeDecimals: 9, tokens: [] }),
    logger: h.logs.logger,
    threshold,
    feeReserve: '5000',
    batchSize: 50,
  });
}

describe('sweep planning is refused under segregated custody (ADR-0020)', () => {
  it('REFUSES to plan a sweep of user addresses', async () => {
    /*
     * A sweep consolidates user deposit addresses into a pool. Under
     * segregated custody that IS the act of commingling — the moment funds
     * pool, one user's balance stops being identifiable on-chain and both
     * bankruptcy-remoteness and per-user reconciliation are gone.
     *
     * It throws rather than returning an empty plan: an empty plan would let
     * someone wire this up, see "nothing to sweep", and conclude it works.
     */
    await expect(service({}).plan()).rejects.toThrow(/commingle segregated funds/);
  });

  it('is not wired into the server at all', async () => {
    // Belt and braces: the refusal above only fires if something calls it.
    // Nothing should.
    const { readFileSync } = await import('node:fs');
    const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(server).not.toContain('createSweepService');
  });
});

describe('sweep accounting (rule 131)', () => {
  it('LEAVES USER LIABILITIES BIT-IDENTICAL', async () => {
    // The defining property. A sweep that changes a user balance is a
    // different operation wearing the name.
    const session = await seedSession(h);
    await creditUser(h, session.userId, SOL_KEY, '5000000000');
    await fundHouse(h, SOL_KEY, '1000000');

    // Read through the repository's own projection rather than re-deriving it
    // here: the thing under test is that the sweep does not move it, and using
    // a second implementation of "what does this user have" would test the
    // wrong thing.
    const ledger = createLedgerRepository(h.app.appDeps.db);
    const before = await ledger.getUserBalance(session.userId, SOL_KEY);

    const posting = service({}).feePosting('sweep-1', SOL_KEY, '5000');

    // Accounts first, outside the posting — the same order the deposit
    // pipeline uses. `postTransaction` writes entries against accounts that
    // must already exist, and the balanced-transaction constraint fires with
    // "has 1 entry" when one of them does not.
    await ledger.ensureAccounts(
      posting.entries.map((entry) => ({
        ownerId: entry.account.ownerId,
        asset: entry.account.asset,
        type: entry.account.type,
      })),
    );

    /*
     * Inside ONE transaction.
     *
     * The balanced-transaction check is a DEFERRED constraint trigger. Posting
     * outside a transaction makes each statement its own implicit one, so the
     * check fires after the first entry and reports "has 1 entry" — which
     * reads like a bug in the posting rather than in how it was called.
     */
    await withTransaction(h.app.appDeps.db, async (tx) => {
      await ledger.postTransaction(
        {
          kind: posting.kind,
          referenceType: posting.referenceType,
          referenceId: posting.referenceId,
          entries: posting.entries.map((entry) => ({
            account: {
              ownerId: entry.account.ownerId,
              asset: entry.account.asset,
              type: entry.account.type,
            },
            asset: entry.asset,
            amount: toBaseUnits(entry.amount),
            direction: entry.direction,
          })),
        },
        tx,
      );
    });

    const after = await ledger.getUserBalance(session.userId, SOL_KEY);
    expect(after).toEqual(before);
  });

  it('posts the fee and nothing else', () => {
    const posting = service({}).feePosting('sweep-2', SOL_KEY, '5000');
    // Two entries: house_fees down, chain_assets down. No user account.
    expect(posting.entries).toHaveLength(2);
    expect(posting.entries.every((e) => e.account.ownerId === null)).toBe(true);
  });
});
