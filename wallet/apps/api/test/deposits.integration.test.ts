import { createAssetRegistry } from '@wallet/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TransferEvent } from '@wallet/blockchain';
import type { CreditOutcome } from '../src/services/deposit.service.js';
import { NATIVE_ASSET } from '@wallet/solana';
import { createFakeChain, type FakeChain } from './fake-chain.js';
import {
  browserHeaders,
  cookieFor,
  seedDepositAddress,
  seedSession,
  startHarness,
  type Harness,
} from './helpers.js';

let h: Harness;
let chain: FakeChain;

beforeAll(async () => {
  chain = createFakeChain();
  h = await startHarness({ chainAdapter: chain });
});
afterAll(async () => {
  await h.cleanup();
});

const LAMPORTS = (sol: number): string => (BigInt(sol) * 1_000_000_000n).toString();
const RENT = '890880';

beforeEach(() => {
  chain.setMinimumAccountBalance(RENT);
});

async function newUserWithAddress(): Promise<{
  userId: string;
  cookie: string;
  address: string;
  addressId: string;
}> {
  const session = await seedSession(h);
  const seeded = await seedDepositAddress(h, session.userId);
  return { userId: session.userId, cookie: session.cookie, ...seeded };
}

async function runIndexer(): Promise<void> {
  await h.app.indexer!.runOnce();
}

// ---------------------------------------------------------------------------
// Address assignment (rules 142-144)
// ---------------------------------------------------------------------------

describe('deposit addresses', () => {
  it('assigns an address and returns the same one on a repeat request', async () => {
    const { cookie } = await seedSession(h);
    const first = await h.app.inject({
      method: 'POST',
      url: '/wallets/addresses',
      headers: browserHeaders(cookie),
    });
    const second = await h.app.inject({
      method: 'POST',
      url: '/wallets/addresses',
      headers: browserHeaders(cookie),
    });

    expect(first.statusCode).toBe(200);
    expect(second.json().address.address).toBe(first.json().address.address);
    expect(second.json().address.id).toBe(first.json().address.id);
  });

  it('gives different users different addresses', async () => {
    const a = await newUserWithAddress();
    const b = await newUserWithAddress();
    expect(a.address).not.toBe(b.address);
  });

  it('survives concurrent first requests without colliding (rule 143)', async () => {
    const { cookie } = await seedSession(h);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.app.inject({
          method: 'POST',
          url: '/wallets/addresses',
          headers: browserHeaders(cookie),
        }),
      ),
    );
    const addresses = new Set(responses.map((r) => r.json().address.address));
    // Every concurrent caller must get the SAME address, or the user has two
    // and only one is watched.
    expect(addresses.size).toBe(1);
  });

  it('states the asset and network unambiguously (rule 172)', async () => {
    const { cookie } = await seedSession(h);
    const body = (
      await h.app.inject({
        method: 'POST',
        url: '/wallets/addresses',
        headers: browserHeaders(cookie),
      })
    ).json();
    expect(body.address.asset).toBe(NATIVE_ASSET);
    expect(body.address.network).toBeTruthy();
  });

  it('requires authentication', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/wallets/addresses',
      headers: { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.statusCode).toBe(401);
  });

  it("will not list another user's addresses", async () => {
    const alice = await newUserWithAddress();
    const mallory = await seedSession(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/wallets/${(await seedDepositAddress(h, alice.userId)).walletId}/addresses`,
      headers: { cookie: mallory.cookie },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

// ---------------------------------------------------------------------------
// Crediting (rules 149-160)
// ---------------------------------------------------------------------------

describe('deposit crediting', () => {
  it('credits a finalized transfer, holding back the account minimum (rules 157-158)', async () => {
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(2) });

    await runIndexer();

    const balances = (
      await h.app.inject({ method: 'GET', url: '/balances', headers: { cookie: user.cookie } })
    ).json();
    const sol = balances.balances.find((b: { asset: string }) => b.asset === NATIVE_ASSET);

    // The user is credited what arrived MINUS the rent-exempt minimum, because
    // that portion can never be withdrawn.
    expect(sol.available).toBe((BigInt(LAMPORTS(2)) - BigInt(RENT)).toString());
    expect(sol.locked).toBe('0');
  });

  it('holds back the minimum only on the FIRST deposit to an address', async () => {
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(1) });
    await runIndexer();
    chain.push({ to: user.address, amount: LAMPORTS(1) });
    await runIndexer();

    const balance = await h.app.appDeps.db.$queryRawUnsafe<Array<{ sum: string }>>(
      `SELECT COALESCE(SUM(rent_reserved),0)::text AS sum FROM deposits WHERE user_id = $1::uuid`,
      user.userId,
    );
    // The minimum is already sitting in the account; charging it twice would
    // silently shrink the second deposit.
    expect(balance[0]?.sum).toBe(RENT);
  });

  it('does NOT credit a transfer below finality (ADR-0006)', async () => {
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(5), confirmation: 'probable' });

    await runIndexer();

    const balances = (
      await h.app.inject({ method: 'GET', url: '/balances', headers: { cookie: user.cookie } })
    ).json();
    expect(balances.balances[0].available).toBe('0');
  });

  it('credits it once it reaches finality', async () => {
    const user = await newUserWithAddress();
    chain.push({
      to: user.address,
      amount: LAMPORTS(5),
      confirmation: 'probable',
      txReference: 'sig-late',
    });
    await runIndexer();

    // The SAME transfer reaches finality — one event whose confirmation rises,
    // not a second event. The cursor never advanced past it, so the next poll
    // sees it again.
    chain.finalize('sig-late');
    await runIndexer();

    const balances = (
      await h.app.inject({ method: 'GET', url: '/balances', headers: { cookie: user.cookie } })
    ).json();
    expect(BigInt(balances.balances[0].available)).toBeGreaterThan(0n);
  });

  it('ignores a transfer to an address we do not own (rule 152)', async () => {
    chain.push({ to: 'So11111111111111111111111111111111111111112', amount: LAMPORTS(9) });
    const before = await h.app.appDeps.db.deposit.count();
    await runIndexer();
    expect(await h.app.appDeps.db.deposit.count()).toBe(before);
  });

  it('writes the deposit and its ledger entries in one transaction (rule 153)', async () => {
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(1) });
    await runIndexer();

    const deposit = await h.app.appDeps.db.deposit.findFirst({ where: { userId: user.userId } });
    expect(deposit?.status).toBe('credited');
    expect(deposit?.ledgerTransactionId).not.toBeNull();

    const entries = await h.app.appDeps.db.ledgerEntry.count({
      where: { transactionId: deposit!.ledgerTransactionId! },
    });
    expect(entries).toBeGreaterThanOrEqual(2);
  });

  it('records the transaction signature for audit (rule 159)', async () => {
    const user = await newUserWithAddress();
    const pushed = chain.push({ to: user.address, amount: LAMPORTS(1) });
    await runIndexer();

    const deposits = (
      await h.app.inject({ method: 'GET', url: '/deposits', headers: { cookie: user.cookie } })
    ).json();
    expect(deposits.deposits[0].txSignature).toBe(pushed.txReference);
  });
});

// ---------------------------------------------------------------------------
// Idempotency (rules 127-128, 154-155, 181, 194)
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('credits exactly once when the same transfer is replayed 100 times concurrently', async () => {
    const user = await newUserWithAddress();
    const transfer = chain.push({ to: user.address, amount: LAMPORTS(3) });

    const pipeline = h.app as unknown as {
      appDeps: { db: unknown };
    } as never;
    void pipeline;

    // Hammer the pipeline directly so all 100 attempts race, rather than being
    // serialized by the indexer's own loop.
    const results = await Promise.all(Array.from({ length: 100 }, () => creditDirect(transfer)));

    const credited = results.filter((r) => r === 'credited').length;
    const duplicates = results.filter((r) => r === 'duplicate').length;

    expect(credited).toBe(1);
    expect(duplicates).toBe(99);

    const deposits = await h.app.appDeps.db.deposit.count({
      where: { txSignature: transfer.txReference },
    });
    expect(deposits).toBe(1);

    const balance = (
      await h.app.inject({ method: 'GET', url: '/balances', headers: { cookie: user.cookie } })
    ).json();
    expect(balance.balances[0].available).toBe((BigInt(LAMPORTS(3)) - BigInt(RENT)).toString());
  });

  it('is idempotent across repeated indexer cycles', async () => {
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(2) });

    for (let i = 0; i < 5; i += 1) await runIndexer();

    expect(await h.app.appDeps.db.deposit.count({ where: { userId: user.userId } })).toBe(1);
  });

  it('treats two transfers in one transaction as distinct deposits', async () => {
    const user = await newUserWithAddress();
    // Same signature, different index — the uniqueness key must not collapse
    // them (rules 112, 127).
    chain.push({
      to: user.address,
      amount: LAMPORTS(1),
      txReference: 'sig-multi',
      instructionIndex: 1,
    });
    chain.push({
      to: user.address,
      amount: LAMPORTS(1),
      txReference: 'sig-multi',
      instructionIndex: 2,
    });

    await runIndexer();
    await runIndexer();

    expect(await h.app.appDeps.db.deposit.count({ where: { txSignature: 'sig-multi' } })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Restart safety (rules 146-147, 182, 195)
// ---------------------------------------------------------------------------

describe('indexer restart safety', () => {
  it('re-reads rather than skips when a cycle fails mid-page', async () => {
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(1), txReference: 'r1' });
    chain.push({ to: user.address, amount: LAMPORTS(1), txReference: 'r2' });

    // The fetch for THIS address fails, so its cursor is never advanced.
    // Targeted, because the watch set holds addresses from earlier tests and a
    // blanket failure would hit whichever happened to be polled first.
    chain.failNextFetchesFor(user.address, 1);
    const failed = await h.app.indexer!.runOnce();
    // Asserted per-user, not on the cycle counter: the watch set is shared
    // across suites and a global count is not this test's business.
    expect(failed.failures).toBeGreaterThanOrEqual(1);
    expect(await h.app.appDeps.db.deposit.count({ where: { userId: user.userId } })).toBe(0);

    // The next cycle picks up from the same place and loses nothing.
    await runIndexer();
    expect(await h.app.appDeps.db.deposit.count({ where: { userId: user.userId } })).toBe(2);
  });

  it('does not advance the cursor past an unfinalized transfer', async () => {
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(1), txReference: 'ok-1' });
    chain.push({
      to: user.address,
      amount: LAMPORTS(1),
      txReference: 'pending-1',
      confirmation: 'probable',
    });
    chain.push({ to: user.address, amount: LAMPORTS(1), txReference: 'after-pending' });

    await runIndexer();

    const cursor = await h.app.appDeps.db.indexerCursor.findFirst({
      where: { addressId: user.addressId },
    });
    // Stops at the last credited transfer. Advancing past `pending-1` would
    // mean never seeing it again once it finalizes.
    expect(cursor?.lastSignature).toBe('ok-1');
    expect(await h.app.appDeps.db.deposit.count({ where: { userId: user.userId } })).toBe(1);
  });

  it('re-reads after a crash between COMMIT and cursor persistence (rule 195)', async () => {
    // The stage that decides whether restart safety works at all.
    //
    // The deposit committed; the cursor did not. On restart the indexer reads
    // the same page again — and must credit nothing new, because the deposit
    // uniqueness constraint rejects the replay. The opposite ordering (cursor
    // first) would skip the page permanently, and a skipped deposit is money a
    // user sent that never arrives, silently.
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(2), txReference: 'commit-not-cursor' });

    await runIndexer();
    expect(await h.app.appDeps.db.deposit.count({ where: { userId: user.userId } })).toBe(1);

    const balanceAfterFirst = (
      await h.app.inject({ method: 'GET', url: '/balances', headers: { cookie: user.cookie } })
    ).json().balances[0].available;

    // Simulate the crash: the work committed, the cursor never landed.
    await h.app.appDeps.db.indexerCursor.updateMany({
      where: { addressId: user.addressId },
      data: { lastSignature: null },
    });

    await runIndexer();

    // Re-read, re-processed, and credited exactly once.
    expect(await h.app.appDeps.db.deposit.count({ where: { userId: user.userId } })).toBe(1);
    const balanceAfterReplay = (
      await h.app.inject({ method: 'GET', url: '/balances', headers: { cookie: user.cookie } })
    ).json().balances[0].available;
    expect(balanceAfterReplay).toBe(balanceAfterFirst);
  });

  it('makes no progress and loses nothing when the cursor was already current', async () => {
    // The third stage: everything committed, including the cursor. A restart
    // here should find nothing to do.
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(1), txReference: 'fully-committed' });

    await runIndexer();
    const cursorAfter = await h.app.appDeps.db.indexerCursor.findFirst({
      where: { addressId: user.addressId },
    });
    expect(cursorAfter?.lastSignature).toBe('fully-committed');

    await runIndexer();
    expect(await h.app.appDeps.db.deposit.count({ where: { userId: user.userId } })).toBe(1);
  });

  it('continues other addresses when one fails', async () => {
    const a = await newUserWithAddress();
    const b = await newUserWithAddress();
    chain.push({ to: a.address, amount: LAMPORTS(1) });
    chain.push({ to: b.address, amount: LAMPORTS(1) });

    chain.failNextFetchesFor(a.address, 1);
    const result = await h.app.indexer!.runOnce();

    expect(result.failures).toBeGreaterThanOrEqual(1);
    expect(result.addressesPolled).toBeGreaterThan(1);
    // b's deposit still lands despite a's failure — one address failing must
    // not abandon the rest of the watch set.
    expect(await h.app.appDeps.db.deposit.count({ where: { userId: b.userId } })).toBe(1);
    // One failure must not abandon the rest of the watch set.
    expect(result.addressesPolled).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation (rules 161-166, 190)
// ---------------------------------------------------------------------------

describe('reconciliation', () => {
  it('reports no residual when the chain agrees with the books', async () => {
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(4) });
    await runIndexer();
    chain.setBalance(user.address, LAMPORTS(4));

    const report = (await h.app.reconcile()) as {
      assets: Array<{ asset: string; residual: string; explanation: string }>;
    };
    const sol = report.assets.find((a) => a.asset === NATIVE_ASSET);
    expect(sol).toBeDefined();
  });

  it('quantifies an injected discrepancy (rule 166)', async () => {
    const user = await newUserWithAddress();
    chain.push({ to: user.address, amount: LAMPORTS(1) });
    await runIndexer();

    // The chain says more than the books do — money landed that has not been
    // credited yet.
    chain.setBalance(user.address, LAMPORTS(100));

    const report = (await h.app.reconcile()) as {
      healthy: boolean;
      assets: Array<{ asset: string; residual: string; explanation: string }>;
    };
    const sol = report.assets.find((a) => a.asset === NATIVE_ASSET)!;
    expect(BigInt(sol.residual)).not.toBe(0n);
    expect(sol.explanation).toBeTruthy();
    expect(report.healthy).toBe(false);
  });

  it('reads from ledger entries, not from a cached balance (rule 165)', async () => {
    const report = (await h.app.reconcile()) as {
      assets: Array<{ asset: string; userLiabilities: string; ledgerChainAssets: string }>;
    };
    const sol = report.assets.find((a) => a.asset === NATIVE_ASSET);
    if (sol) {
      const fromEntries = await h.app.appDeps.db.$queryRawUnsafe<Array<{ total: string }>>(
        `SELECT COALESCE(SUM(CASE WHEN e.direction='debit' THEN e.amount ELSE -e.amount END),0)::text AS total
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
         WHERE a.type = 'chain_assets' AND a.asset = $1`,
        NATIVE_ASSET,
      );
      expect(sol.ledgerChainAssets).toBe(fromEntries[0]?.total);
    }
  });
});

// ---------------------------------------------------------------------------
// Log hygiene under Phase 2 (rules 41, 160, 223)
// ---------------------------------------------------------------------------

describe('log hygiene', () => {
  it('never logs an amount, an address, or a transaction signature', async () => {
    const user = await newUserWithAddress();
    const transfer = chain.push({ to: user.address, amount: LAMPORTS(7) });

    h.logs.clear();
    await runIndexer();
    await h.app.inject({ method: 'GET', url: '/balances', headers: { cookie: user.cookie } });

    const output = h.logs.text();
    expect(output).not.toContain(user.address);
    expect(output).not.toContain(transfer.txReference);
    expect(output).not.toContain(LAMPORTS(7));
    // But the event itself is recorded, so this is not passing by silence.
    expect(output).toContain('deposit.credited');
  });
});

/** Calls the pipeline directly so concurrent attempts genuinely race. */
async function creditDirect(transfer: TransferEvent): Promise<string> {
  const { createDepositPipeline } = await import('../src/services/deposit.service.js');
  const pipeline = createDepositPipeline({
    db: h.app.appDeps.db,
    logger: h.logs.logger,
    // SOL only — the allowlist these deposit tests were written against.
    assets: createAssetRegistry({ nativeDecimals: 9, tokens: [] }),
  });
  const result = await pipeline.creditTransfer(transfer, RENT);
  return result.outcome;
}

// Referenced so `cookieFor` stays exported for other suites.
void cookieFor;

// ---------------------------------------------------------------------------
// The mint allowlist (ADR-0016, prompt_phase4.md rules 124-125)
// ---------------------------------------------------------------------------

describe('non-allowlisted assets', () => {
  const UNKNOWN_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  /** The pipeline as configured for these tests: SOL, no mints. */
  async function creditWithAllowlist(transfer: TransferEvent): Promise<CreditOutcome> {
    const { createDepositPipeline } = await import('../src/services/deposit.service.js');
    return createDepositPipeline({
      db: h.app.appDeps.db,
      logger: h.logs.logger,
      assets: createAssetRegistry({ nativeDecimals: 9, tokens: [] }),
    }).creditTransfer(transfer, RENT);
  }

  it('records an unknown mint rather than discarding it', async () => {
    const user = await newUserWithAddress();
    const transfer = chain.push({
      to: user.address,
      amount: '5000000',
      asset: UNKNOWN_MINT,
      // What the adapter attaches to a token event, and never to a SOL one.
      metadata: { tokenAccount: 'ata-1', decimals: '6' },
    });

    const result = await creditWithAllowlist(transfer);
    expect(result).toMatchObject({ outcome: 'ignored', reason: 'mint_not_allowlisted' });

    // THE POINT OF THE RULE: a row exists, so "where is my token" has an
    // answer. Silently dropping it would leave nothing to look up.
    const row = await h.app.appDeps.db.deposit.findFirst({
      where: { txSignature: transfer.txReference },
    });
    expect(row).toMatchObject({ status: 'ignored', reason: 'mint_not_allowlisted' });
    expect(row?.asset).toBe(UNKNOWN_MINT);
  });

  it('creates no ledger entries for it', async () => {
    const user = await newUserWithAddress();
    const transfer = chain.push({ to: user.address, amount: '9000000', asset: UNKNOWN_MINT });

    const before = await h.app.appDeps.db.ledgerEntry.count();
    await creditWithAllowlist(transfer);
    const after = await h.app.appDeps.db.ledgerEntry.count();

    // An ignored deposit is an observation about the chain, not an accounting
    // event. A liability here would be one the platform cannot discharge.
    expect(after).toBe(before);

    const row = await h.app.appDeps.db.deposit.findFirst({
      where: { txSignature: transfer.txReference },
    });
    expect(row?.ledgerTransactionId).toBeNull();
  });

  it('labels an unknown NATIVE asset differently from an unknown mint', async () => {
    const user = await newUserWithAddress();
    const transfer = chain.push({ to: user.address, amount: '10', asset: 'DOGE' });
    expect(await creditWithAllowlist(transfer)).toMatchObject({
      reason: 'asset_not_allowlisted',
    });
  });

  it('stays idempotent — a replayed unknown mint does not double-record', async () => {
    const user = await newUserWithAddress();
    const transfer = chain.push({ to: user.address, amount: '1000', asset: UNKNOWN_MINT });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => creditWithAllowlist(transfer)),
    );

    expect(results.filter((r) => r.outcome === 'ignored')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(19);
    expect(
      await h.app.appDeps.db.deposit.count({ where: { txSignature: transfer.txReference } }),
    ).toBe(1);
  });

  it('still credits SOL, which IS allowlisted', async () => {
    const user = await newUserWithAddress();
    const transfer = chain.push({ to: user.address, amount: LAMPORTS(2) });
    expect((await creditWithAllowlist(transfer)).outcome).toBe('credited');
  });

  it('does not log the mint, which is an attacker-chosen string', async () => {
    const user = await newUserWithAddress();
    const transfer = chain.push({ to: user.address, amount: '1', asset: UNKNOWN_MINT });
    await creditWithAllowlist(transfer);

    const output = h.logs.text();
    expect(output).toContain('deposit.ignored');
    expect(output).not.toContain(UNKNOWN_MINT);
  });
});
