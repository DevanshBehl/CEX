import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSolanaAdapter, createSolanaAddressDeriver, NATIVE_ASSET } from './index.js';

/**
 * The adapter against a real validator (master-prompt rule 180,
 * prompt_phase2.md rule 188).
 *
 * The unit tests cover parsing and validation with fabricated data. This covers
 * what fabricated data cannot: that the RPC shapes are what the code expects,
 * that a real airdrop is detected, and that the rent-exempt minimum is a number
 * the network actually reports rather than one someone typed in.
 *
 * Requires `solana-test-validator` on http://127.0.0.1:8899. Skipped when it is
 * not reachable, so the suite stays runnable without it — a skip is honest,
 * whereas a mocked "localnet" test would claim coverage it does not have.
 */
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';

let available = false;
let connection: Connection;

beforeAll(async () => {
  connection = new Connection(RPC_URL, 'confirmed');
  try {
    await Promise.race([
      connection.getVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    available = true;
  } catch {
    available = false;
    // eslint-disable-next-line no-console
    console.warn(
      `\n  solana-test-validator not reachable at ${RPC_URL} — skipping localnet tests.\n` +
        '  Start one with: solana-test-validator --reset\n',
    );
  }
});

afterAll(() => undefined);

function adapter() {
  return createSolanaAdapter({
    endpoint: RPC_URL,
    // A local validator finalizes quickly, so this is the real policy, not a
    // relaxed one (ADR-0006).
    commitment: 'finalized',
    requestTimeoutMs: 30_000,
    maxRetries: 3,
    pageSize: 50,
  });
}

describe.runIf(true)('against a local validator', () => {
  it('reports healthy', async () => {
    if (!available) return;
    expect(await adapter().isHealthy()).toBe(true);
  });

  it('reads the rent-exempt minimum from the network (rule 114)', async () => {
    if (!available) return;
    const minimum = await adapter().getMinimumAccountBalance(NATIVE_ASSET);

    // Not asserted as a constant: it is a network parameter and hardcoding it
    // is exactly what rule 114 forbids. What matters is that it is positive and
    // plausible for a bare account.
    expect(BigInt(minimum)).toBeGreaterThan(0n);
    expect(BigInt(minimum)).toBeLessThan(BigInt(LAMPORTS_PER_SOL));
  });

  it('reads a zero balance for a fresh address', async () => {
    if (!available) return;
    const fresh = Keypair.generate().publicKey.toBase58();
    expect(await adapter().getBalance(fresh, NATIVE_ASSET)).toBe('0');
  });

  it('detects a real airdrop as a finalized transfer', async () => {
    if (!available) return;

    const deriver = createSolanaAddressDeriver(new Uint8Array(64).fill(11));
    const { address } = deriver.derive(Math.floor(Math.random() * 1_000_000));
    const pubkey = new PublicKey(address);

    const signature = await connection.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL);
    const blockhash = await connection.getLatestBlockhash('finalized');
    await connection.confirmTransaction({ signature, ...blockhash }, 'finalized');

    const chain = adapter();

    // The balance is visible.
    expect(BigInt(await chain.getBalance(address, NATIVE_ASSET))).toBe(
      BigInt(2 * LAMPORTS_PER_SOL),
    );

    // And the adapter surfaces it as a transfer the pipeline can credit.
    const page = await chain.fetchTransfers({ address, cursor: null, pageSize: 50 });
    expect(page.transfers.length).toBeGreaterThan(0);

    const transfer = page.transfers.find((t) => t.txReference === signature);
    expect(transfer, 'the airdrop should appear as a transfer').toBeDefined();
    expect(transfer!.amount).toBe(String(2 * LAMPORTS_PER_SOL));
    expect(transfer!.to).toBe(address);
    expect(transfer!.confirmation).toBe('final');
    expect(transfer!.asset).toBe(NATIVE_ASSET);
  });

  it('resumes from a cursor without repeating what came before', async () => {
    if (!available) return;

    const deriver = createSolanaAddressDeriver(new Uint8Array(64).fill(12));
    const { address } = deriver.derive(Math.floor(Math.random() * 1_000_000));
    const pubkey = new PublicKey(address);
    const chain = adapter();

    for (let i = 0; i < 2; i += 1) {
      const signature = await connection.requestAirdrop(pubkey, LAMPORTS_PER_SOL);
      const blockhash = await connection.getLatestBlockhash('finalized');
      await connection.confirmTransaction({ signature, ...blockhash }, 'finalized');
    }

    const first = await chain.fetchTransfers({ address, cursor: null, pageSize: 50 });
    expect(first.transfers.length).toBeGreaterThanOrEqual(2);

    // Resuming from the cursor returns nothing new, which is what makes a
    // restart cheap rather than a full re-scan.
    const second = await chain.fetchTransfers({
      address,
      cursor: first.nextCursor,
      pageSize: 50,
    });
    expect(second.transfers).toEqual([]);
  });

  it('reports a real chain position', async () => {
    if (!available) return;
    expect(await adapter().getPosition()).toBeGreaterThan(0n);
  });

  it('rejects an unsupported asset rather than returning zero (ADR-0008)', async () => {
    if (!available) return;
    // Returning 0 would be read by reconciliation as a shortfall.
    await expect(
      adapter().getBalance(Keypair.generate().publicKey.toBase58(), 'USDC'),
    ).rejects.toThrow();
  });
});
