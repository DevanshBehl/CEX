import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLedgerRepository,
  createPrismaClient,
  newId,
  withTransaction,
  type EntryInput,
  type PrismaClient,
} from './index.js';

/**
 * The ledger's database-level guarantees (prompt_phase2.md rules 184-185,
 * 199-201).
 *
 * These cannot be tested against a mock: what is under test IS the database —
 * role grants, an append-only trigger, a deferred constraint trigger, a CHECK.
 * A fake would pass while proving nothing.
 */
const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.MIGRATION_DATABASE_URL;

let db: PrismaClient;
let owner: PrismaClient;
let ledger: ReturnType<typeof createLedgerRepository>;

// Cluster-qualified (ADR-0021). The database now REFUSES a bare asset key, so
// a test using one would fail for the wrong reason.
const ASSET = 'localnet:TESTSOL';
const userA = newId();
const userB = newId();

beforeAll(async () => {
  if (!APP_URL || !OWNER_URL) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL required');
  db = createPrismaClient({ url: APP_URL });
  owner = createPrismaClient({ url: OWNER_URL });
  ledger = createLedgerRepository(db);
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
  await owner.$disconnect();
});

async function postDepositLike(userId: string, amount: string, rent = '0'): Promise<string> {
  // Mirrors what the deposit pipeline does: accounts are created outside the
  // serializable transaction, because doing it inside made account creation
  // the dominant source of write conflicts.
  await ledger.ensureAccounts([
    { ownerId: null, asset: ASSET, type: 'chain_assets' },
    { ownerId: userId, asset: ASSET, type: 'user_available' },
    { ownerId: null, asset: ASSET, type: 'house_rent' },
  ]);

  return withTransaction(db, async (tx) => {
    // Annotated explicitly: TypeScript narrows an array literal from its first
    // element, so pushing a credit into an array inferred from a debit fails.
    const entries: EntryInput[] = [
      {
        account: { ownerId: null, asset: ASSET, type: 'chain_assets' as const },
        asset: ASSET,
        amount,
        direction: 'debit',
      },
    ];
    const creditable = (BigInt(amount) - BigInt(rent)).toString();
    if (BigInt(creditable) > 0n) {
      entries.push({
        account: { ownerId: userId, asset: ASSET, type: 'user_available' },
        asset: ASSET,
        amount: creditable,
        direction: 'credit',
      });
    }
    if (BigInt(rent) > 0n) {
      entries.push({
        account: { ownerId: null, asset: ASSET, type: 'house_rent' },
        asset: ASSET,
        amount: rent,
        direction: 'credit',
      });
    }
    return createLedgerRepository(tx).postTransaction(
      { kind: 'deposit', referenceType: 'deposit', referenceId: newId(), entries },
      tx,
    );
  });
}

describe('posting transactions', () => {
  it('writes a balanced transaction and projects the balance', async () => {
    await postDepositLike(userA, '1000000000');
    const balance = await ledger.getUserBalance(userA, ASSET);
    expect(balance.available).toBe('1000000000');
    expect(balance.locked).toBe('0');
    expect(balance.total).toBe('1000000000');
  });

  it('accumulates across transactions', async () => {
    await postDepositLike(userB, '500');
    await postDepositLike(userB, '250');
    expect((await ledger.getUserBalance(userB, ASSET)).available).toBe('750');
  });

  it('splits rent away from the user', async () => {
    const user = newId();
    await postDepositLike(user, '1000000', '890880');
    expect((await ledger.getUserBalance(user, ASSET)).available).toBe('109120');
  });

  it('handles amounts far above 2^53 exactly (rule 201)', async () => {
    const user = newId();
    const huge = '123456789012345678901234567';
    await postDepositLike(user, huge);
    // NUMERIC(38,0) round-trips exactly; a float column would not.
    expect((await ledger.getUserBalance(user, ASSET)).available).toBe(huge);
  });

  it('creates each account exactly once under concurrency', async () => {
    const user = newId();
    await Promise.all(Array.from({ length: 10 }, () => postDepositLike(user, '10')));

    const accounts = await db.ledgerAccount.count({
      where: { ownerId: user, asset: ASSET, type: 'user_available' },
    });
    expect(accounts).toBe(1);
    expect((await ledger.getUserBalance(user, ASSET)).available).toBe('100');
  });
});

describe('the database rejects an unbalanced transaction (rule 200)', () => {
  it('rejects at COMMIT, not at insert', async () => {
    await expect(
      withTransaction(db, async (tx) => {
        return createLedgerRepository(tx).postTransaction(
          {
            kind: 'deposit',
            referenceType: 'deposit',
            referenceId: newId(),
            entries: [
              {
                account: { ownerId: null, asset: ASSET, type: 'chain_assets' },
                asset: ASSET,
                amount: '1000',
                direction: 'debit',
              },
              {
                account: { ownerId: userA, asset: ASSET, type: 'user_available' },
                asset: ASSET,
                amount: '999',
                direction: 'credit',
              },
            ],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects a single-entry transaction', async () => {
    await expect(
      withTransaction(db, async (tx) =>
        createLedgerRepository(tx).postTransaction(
          {
            kind: 'adjustment',
            referenceType: 'test',
            referenceId: newId(),
            entries: [
              {
                account: { ownerId: null, asset: ASSET, type: 'chain_assets' },
                asset: ASSET,
                amount: '1',
                direction: 'debit',
              },
            ],
          },
          tx,
        ),
      ),
    ).rejects.toThrow(/at least two/);
  });

  it('balances per asset, not in aggregate (rule 79)', async () => {
    await expect(
      withTransaction(db, async (tx) =>
        createLedgerRepository(tx).postTransaction(
          {
            kind: 'adjustment',
            referenceType: 'test',
            referenceId: newId(),
            entries: [
              {
                account: { ownerId: null, asset: ASSET, type: 'chain_assets' },
                asset: ASSET,
                amount: '100',
                direction: 'debit',
              },
              {
                account: { ownerId: null, asset: 'localnet:OTHER', type: 'chain_assets' },
                asset: 'localnet:OTHER',
                amount: '100',
                direction: 'credit',
              },
            ],
          },
          tx,
        ),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it('leaves nothing behind when it rejects', async () => {
    const reference = newId();
    await withTransaction(db, async (tx) =>
      createLedgerRepository(tx).postTransaction(
        {
          kind: 'adjustment',
          referenceType: 'rollback-test',
          referenceId: reference,
          entries: [
            {
              account: { ownerId: null, asset: ASSET, type: 'chain_assets' },
              asset: ASSET,
              amount: '5',
              direction: 'debit',
            },
            {
              account: { ownerId: userA, asset: ASSET, type: 'user_available' },
              asset: ASSET,
              amount: '4',
              direction: 'credit',
            },
          ],
        },
        tx,
      ),
    ).catch(() => undefined);

    expect(await db.ledgerTransaction.count({ where: { referenceId: reference } })).toBe(0);
  });
});

describe('serialization conflicts are retried, not surfaced', () => {
  /**
   * REGRESSION TEST.
   *
   * `withTransaction` defaults to Serializable because the ledger needs it, and
   * under Serializable write conflicts are NORMAL — retrying is what makes the
   * isolation level usable at all.
   *
   * Prisma reports a serialization failure as P2034 ("write conflict or
   * deadlock") and does NOT surface the underlying 40001 SQLSTATE. The retry
   * predicate originally checked only for 40001/40P01, so it never matched and
   * the loop never ran: two concurrent writes to the same account produced a
   * 500 instead of one of them taking a moment longer.
   */
  it('completes concurrent conflicting writes without surfacing a conflict', async () => {
    const user = newId();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => postDepositLike(user, '5')),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected, 'every write should have succeeded, retrying if needed').toEqual([]);
    expect((await ledger.getUserBalance(user, ASSET)).available).toBe('60');
  });
});

describe('a rejected commit is reported as a failure', () => {
  /**
   * REGRESSION TEST for a real Prisma behaviour.
   *
   * The balance check is a DEFERRED constraint, so it fires at COMMIT — and
   * Prisma's `$transaction` resolves with the callback's return value even
   * when PostgreSQL rejects that commit and rolls everything back. Verified
   * against Prisma 6.1.
   *
   * For a ledger that is the worst failure mode available: the books say the
   * money did not move, the application says it did, and nothing errors.
   *
   * `withTransaction` now issues `SET CONSTRAINTS ALL IMMEDIATE` before
   * returning, forcing the check inside the transaction where the error
   * propagates. This test fails if that is ever removed.
   */
  it('does not report success for a transaction the database rolled back', async () => {
    const reference = newId();
    let resolvedSilently = false;

    try {
      await withTransaction(db, async (tx) =>
        createLedgerRepository(tx).postTransaction(
          {
            kind: 'adjustment',
            referenceType: 'commit-propagation',
            referenceId: reference,
            entries: [
              {
                account: { ownerId: null, asset: ASSET, type: 'chain_assets' },
                asset: ASSET,
                amount: '100',
                direction: 'debit',
              },
              {
                account: { ownerId: userA, asset: ASSET, type: 'user_available' },
                asset: ASSET,
                amount: '99',
                direction: 'credit',
              },
            ],
          },
          tx,
        ),
      );
      resolvedSilently = true;
    } catch {
      // Expected.
    }

    const persisted = await db.ledgerTransaction.count({ where: { referenceId: reference } });
    expect(persisted, 'nothing should have been written').toBe(0);
    expect(resolvedSilently, 'the caller must be told the write failed').toBe(false);
  });
});

describe('the ledger is append-only (rule 199)', () => {
  it('refuses UPDATE and DELETE for the application role', async () => {
    await postDepositLike(userA, '10');
    await expect(db.$executeRawUnsafe('UPDATE ledger_entries SET amount = 1')).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM ledger_entries')).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe("UPDATE ledger_transactions SET kind = 'adjustment'"),
    ).rejects.toThrow();
  });

  it('refuses UPDATE and DELETE for the SCHEMA OWNER too', async () => {
    // Defence in depth: a migration or a psql session cannot quietly correct a
    // balance either. A real correction is a reversing adjustment.
    await expect(owner.$executeRawUnsafe('UPDATE ledger_entries SET amount = 1')).rejects.toThrow(
      /append-only/,
    );
    await expect(owner.$executeRawUnsafe('DELETE FROM ledger_entries')).rejects.toThrow(
      /append-only/,
    );
  });

  it('keeps the balance intact after every rejected mutation', async () => {
    const before = await ledger.getUserBalance(userA, ASSET);
    await db.$executeRawUnsafe('UPDATE ledger_entries SET amount = 1').catch(() => undefined);
    await db.$executeRawUnsafe('DELETE FROM ledger_entries').catch(() => undefined);
    expect(await ledger.getUserBalance(userA, ASSET)).toEqual(before);
  });
});

describe('entry-level constraints', () => {
  it('rejects a zero or negative amount', async () => {
    for (const amount of ['0', '-5']) {
      await expect(
        withTransaction(db, async (tx) =>
          createLedgerRepository(tx).postTransaction(
            {
              kind: 'adjustment',
              referenceType: 'test',
              referenceId: newId(),
              entries: [
                {
                  account: { ownerId: null, asset: ASSET, type: 'chain_assets' },
                  asset: ASSET,
                  amount,
                  direction: 'debit',
                },
                {
                  account: { ownerId: userA, asset: ASSET, type: 'user_available' },
                  asset: ASSET,
                  amount,
                  direction: 'credit',
                },
              ],
            },
            tx,
          ),
        ),
        amount,
      ).rejects.toThrow();
    }
  });

  it('rejects an entry whose asset disagrees with its account', async () => {
    await expect(
      db.$executeRawUnsafe(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, asset, amount, direction, created_at)
        SELECT gen_random_uuid(), t.id, a.id, 'MISMATCH', 1, 'debit', now()
        FROM ledger_transactions t, ledger_accounts a
        WHERE a.asset = '${ASSET}' LIMIT 1
      `),
    ).rejects.toThrow();
  });
});

describe('cluster isolation, enforced by the database (ADR-0021)', () => {
  const MAINNET = 'mainnet-beta:TESTSOL';

  it('refuses a transaction that debits one cluster and credits another', async () => {
    // The per-asset balance check catches this as two unbalanced groups. That
    // it is caught at all is the point; the message is the database's.
    await expect(
      withTransaction(db, async (tx) =>
        createLedgerRepository(tx).postTransaction(
          {
            kind: 'adjustment',
            referenceType: 'test',
            referenceId: newId(),
            entries: [
              {
                account: { ownerId: null, asset: ASSET, type: 'chain_assets' },
                asset: ASSET,
                amount: '100',
                direction: 'debit',
              },
              {
                account: { ownerId: userA, asset: MAINNET, type: 'user_available' },
                asset: MAINNET,
                amount: '100',
                direction: 'credit',
              },
            ],
          },
          tx,
        ),
      ),
    ).rejects.toThrow();
  });

  it('REFUSES A TRANSACTION THAT BALANCES IN BOTH CLUSTERS', async () => {
    /*
     * The case the balance check alone lets through: two balanced pairs, one
     * per cluster. Nothing is unbalanced and nothing crosses — and yet one
     * financial event claims to have happened on two chains, which means
     * settling it is undoable on one of them.
     *
     * This is what `ledger_entries_single_cluster` exists for, and this test
     * is the only thing that proves the trigger is installed and firing.
     */
    await expect(
      withTransaction(db, async (tx) =>
        createLedgerRepository(tx).postTransaction(
          {
            kind: 'adjustment',
            referenceType: 'test',
            referenceId: newId(),
            entries: [
              {
                account: { ownerId: null, asset: ASSET, type: 'chain_assets' },
                asset: ASSET,
                amount: '100',
                direction: 'debit',
              },
              {
                account: { ownerId: userA, asset: ASSET, type: 'user_available' },
                asset: ASSET,
                amount: '100',
                direction: 'credit',
              },
              {
                account: { ownerId: null, asset: MAINNET, type: 'chain_assets' },
                asset: MAINNET,
                amount: '100',
                direction: 'debit',
              },
              {
                account: { ownerId: userA, asset: MAINNET, type: 'user_available' },
                asset: MAINNET,
                amount: '100',
                direction: 'credit',
              },
            ],
          },
          tx,
        ),
      ),
    ).rejects.toThrow(/spans clusters/);
  });

  it('refuses an account whose asset carries no cluster', async () => {
    // Straight to SQL: the repository's own helpers would be the thing under
    // test otherwise, and the guarantee being checked is the database's.
    await expect(
      db.$executeRawUnsafe(`
        INSERT INTO ledger_accounts (id, owner_id, asset, type, created_at)
        VALUES (gen_random_uuid(), NULL, 'SOL', 'chain_assets', now())
      `),
    ).rejects.toThrow();
  });

  it('refuses an asset key whose prefix is not a real cluster', async () => {
    await expect(
      db.$executeRawUnsafe(`
        INSERT INTO ledger_accounts (id, owner_id, asset, type, created_at)
        VALUES (gen_random_uuid(), NULL, 'staging:SOL', 'chain_assets', now())
      `),
    ).rejects.toThrow();
  });

  it('refuses an address on an unqualified chain', async () => {
    await expect(
      db.$executeRawUnsafe(`
        UPDATE addresses SET chain = 'solana' WHERE id = (SELECT id FROM addresses LIMIT 1)
      `),
    ).rejects.toThrow();
  });
});

describe('no balance column exists (rule 196)', () => {
  it('has no column that could shadow the projection', async () => {
    const columns = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name LIKE '%balance%' OR column_name = 'available' OR column_name = 'locked')
    `);
    // A balance column becomes the value everything reads, drifts from the
    // entries that define it, and then there are two answers with no
    // principled way to choose. There must be none.
    expect(columns).toEqual([]);
  });

  it('stores amounts as NUMERIC, never as a float (rule 201)', async () => {
    const columns = await db.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('amount', 'rent_reserved')
    `);
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column.data_type, column.column_name).toBe('numeric');
    }
  });

  it('uses timestamptz everywhere', async () => {
    const wrong = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
    `);
    expect(wrong).toEqual([]);
  });
});
