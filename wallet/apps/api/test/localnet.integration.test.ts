import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSolanaAdapter, NATIVE_ASSET } from '@wallet/solana';
import {
  browserHeaders,
  seedDepositAddress,
  seedSession,
  startHarness,
  type Harness,
} from './helpers.js';

/**
 * The whole Phase 2 path against a real validator
 * (prompt_phase2.md rules 188, 204).
 *
 *   airdrop → indexer detects → ledger credits → API shows the balance
 *
 * Everything else in the suite uses a fake chain, because restart safety and
 * idempotency are properties of ordering and need a controllable transport.
 * This one exists to prove the real adapter is wired to the real pipeline —
 * that the RPC shapes, the commitment handling, and the rent split all survive
 * contact with an actual network.
 *
 * Requires `solana-test-validator`. Skipped when unreachable: a skip is honest,
 * a mocked "localnet" test is not.
 */
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';

let h: Harness;
let connection: Connection;
let available = false;

beforeAll(async () => {
  connection = new Connection(RPC_URL, 'confirmed');
  try {
    await Promise.race([
      connection.getVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    available = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`\n  solana-test-validator not reachable at ${RPC_URL} — skipping.\n`);
    return;
  }

  h = await startHarness({
    chainAdapter: createSolanaAdapter({
      endpoint: RPC_URL,
      commitment: 'finalized',
      requestTimeoutMs: 30_000,
      maxRetries: 3,
      pageSize: 50,
    }),
  });
});

afterAll(async () => {
  if (available && h) await h.cleanup();
});

describe('end to end on localnet', () => {
  it('credits a real airdrop and shows it through the API', async () => {
    if (!available) return;

    const session = await seedSession(h);
    const { address } = await seedDepositAddress(h, session.userId);

    // Nothing yet.
    const before = (
      await h.app.inject({ method: 'GET', url: '/balances', headers: { cookie: session.cookie } })
    ).json();
    expect(before.balances.find((b: { asset: string }) => b.asset === NATIVE_ASSET).available).toBe(
      '0',
    );

    // Real money, on a real chain.
    const signature = await connection.requestAirdrop(new PublicKey(address), 2 * LAMPORTS_PER_SOL);
    const blockhash = await connection.getLatestBlockhash('finalized');
    await connection.confirmTransaction({ signature, ...blockhash }, 'finalized');

    await h.app.indexer!.runOnce();

    // Asserted on THIS user's deposits rather than the cycle's credit count:
    // the watch set is shared across suites, so a global counter measures
    // whatever else happens to be pending.
    expect(await h.app.appDeps.db.deposit.count({ where: { userId: session.userId } })).toBe(1);

    // Visible to the user, minus the rent-exempt minimum the network requires
    // for the account to exist (rules 157-158).
    const after = (
      await h.app.inject({ method: 'GET', url: '/balances', headers: { cookie: session.cookie } })
    ).json();
    const sol = after.balances.find((b: { asset: string }) => b.asset === NATIVE_ASSET);

    const credited = BigInt(sol.available);
    expect(credited).toBeGreaterThan(0n);
    expect(credited).toBeLessThan(BigInt(2 * LAMPORTS_PER_SOL));

    // The deposit is recorded with its on-chain reference (rule 159).
    const deposits = (
      await h.app.inject({ method: 'GET', url: '/deposits', headers: { cookie: session.cookie } })
    ).json();
    expect(deposits.deposits[0].txSignature).toBe(signature);
    expect(deposits.deposits[0].status).toBe('credited');
    expect(deposits.deposits[0].amount).toBe(String(2 * LAMPORTS_PER_SOL));

    // amount = creditedAmount + rentReserved, exactly. Nothing is lost.
    const deposit = deposits.deposits[0];
    expect(BigInt(deposit.creditedAmount) + BigInt(deposit.rentReserved)).toBe(
      BigInt(deposit.amount),
    );
  });

  it('is idempotent across repeated cycles against the real chain', async () => {
    if (!available) return;

    const session = await seedSession(h);
    const { address } = await seedDepositAddress(h, session.userId);

    const signature = await connection.requestAirdrop(new PublicKey(address), LAMPORTS_PER_SOL);
    const blockhash = await connection.getLatestBlockhash('finalized');
    await connection.confirmTransaction({ signature, ...blockhash }, 'finalized');

    for (let i = 0; i < 3; i += 1) await h.app.indexer!.runOnce();

    expect(await h.app.appDeps.db.deposit.count({ where: { userId: session.userId } })).toBe(1);
  });

  it('reconciles against the real chain with no unexplained residual', async () => {
    if (!available) return;

    const report = (await h.app.reconcile()) as {
      assets: Array<{
        asset: string;
        residual: string;
        explanation: string;
        addressesChecked: number;
      }>;
    };
    const sol = report.assets.find((a) => a.asset === NATIVE_ASSET);
    expect(sol).toBeDefined();
    // Whatever the residual, it must come with an explanation (rule 163).
    expect(sol!.explanation.length).toBeGreaterThan(0);
  });

  it('creates an address the network itself considers valid', async () => {
    if (!available) return;

    const session = await seedSession(h);
    const response = await h.app.inject({
      method: 'POST',
      url: '/wallets/addresses',
      headers: browserHeaders(session.cookie),
    });
    const { address } = response.json().address;

    // The real test of an address is whether the chain accepts it.
    await expect(connection.getBalance(new PublicKey(address))).resolves.toBeTypeOf('number');
  });
});
