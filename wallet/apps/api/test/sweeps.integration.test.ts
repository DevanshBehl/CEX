import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAssetRegistry } from '@wallet/types';
import { createLedgerRepository, withTransaction } from '@wallet/db';
import { toBaseUnits } from '@wallet/ledger';
import { createSweepService } from '../src/services/sweep.service.js';
import { creditUser, fundHouse, seedSession, startHarness, type Harness } from './helpers.js';

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
    chain: 'solana',
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
    chain: 'solana',
    assets: createAssetRegistry({ nativeDecimals: 9, tokens: [] }),
    logger: h.logs.logger,
    threshold,
    feeReserve: '5000',
    batchSize: 50,
  });
}

async function addressFor(): Promise<string> {
  const session = await seedSession(h);
  const response = await h.app.inject({
    method: 'POST',
    url: '/wallets/addresses',
    headers: {
      cookie: session.cookie,
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
    },
  });
  const body = response.json() as { address: { address: string } };
  return body.address.address;
}

describe('sweep planning', () => {
  it('NEVER plans to sweep the rent-exempt minimum', async () => {
    // A swept-to-zero account ceases to exist, and the next deposit pays to
    // recreate it (rule 133).
    const address = await addressFor();
    const candidates = await service({ [address]: '10000000' }, '0').plan();

    const mine = candidates.find((c) => c.address === address);
    expect(mine).toBeDefined();
    expect(BigInt(mine!.plan.amount)).toBe(10_000_000n - BigInt(RENT) - 5_000n);
    expect(BigInt(mine!.plan.amount)).toBeLessThan(10_000_000n);
  });

  it('does not plan to sweep dust', async () => {
    // Sweeping dust costs more in fees than it consolidates, and lets anyone
    // make the platform pay fees on demand by sending it.
    const address = await addressFor();
    const candidates = await service({ [address]: String(BigInt(RENT) + 6_000n) }).plan();
    expect(candidates.find((c) => c.address === address)).toBeUndefined();
  });

  it('does not plan to sweep an address sitting at the minimum', async () => {
    const address = await addressFor();
    const candidates = await service({ [address]: RENT }, '0').plan();
    expect(candidates.find((c) => c.address === address)).toBeUndefined();
  });

  it('skips an address the chain cannot be read for, rather than failing the batch', async () => {
    // One unreadable address must not stop every other address being swept.
    const address = await addressFor();
    const failing = createSweepService({
      db: h.app.appDeps.db,
      reader: {
        ...reader({ [address]: '10000000' }),
        async getBalance() {
          throw new Error('rpc down');
        },
      } as never,
      chain: 'solana',
      assets: createAssetRegistry({ nativeDecimals: 9, tokens: [] }),
      logger: h.logs.logger,
      threshold: '0',
      feeReserve: '5000',
      batchSize: 50,
    });

    await expect(failing.plan()).resolves.toEqual([]);
  });
});

describe('sweep accounting (rule 131)', () => {
  it('LEAVES USER LIABILITIES BIT-IDENTICAL', async () => {
    // The defining property. A sweep that changes a user balance is a
    // different operation wearing the name.
    const session = await seedSession(h);
    await creditUser(h, session.userId, 'SOL', '5000000000');
    await fundHouse(h, 'SOL', '1000000');

    // Read through the repository's own projection rather than re-deriving it
    // here: the thing under test is that the sweep does not move it, and using
    // a second implementation of "what does this user have" would test the
    // wrong thing.
    const ledger = createLedgerRepository(h.app.appDeps.db);
    const before = await ledger.getUserBalance(session.userId, 'SOL');

    const posting = service({}).feePosting('sweep-1', 'SOL', '5000');

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

    const after = await ledger.getUserBalance(session.userId, 'SOL');
    expect(after).toEqual(before);
  });

  it('posts the fee and nothing else', () => {
    const posting = service({}).feePosting('sweep-2', 'SOL', '5000');
    // Two entries: house_fees down, chain_assets down. No user account.
    expect(posting.entries).toHaveLength(2);
    expect(posting.entries.every((e) => e.account.ownerId === null)).toBe(true);
  });
});
