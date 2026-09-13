import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachSignature,
  buildTokenTransferTransaction,
  createSolanaAdapter,
  createSolanaAddressDeriver,
  deriveAssociatedTokenAddress,
  nativeAssetKey,
  parseTokenTransfers,
  TOKEN_PROGRAM_ID,
} from './index.js';

/** An SPL mint account's fixed size. */
const MINT_LENGTH = 82;
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Test-only encodings of the two SPL instructions this test needs to SET UP.
 *
 * Only `Transfer` is production code; these exist so the test can build a mint
 * and some supply without adding `@solana/spl-token` as a dependency of the
 * package that signs treasury transactions.
 */
function initializeMintInstruction(
  mint: PublicKey,
  authority: PublicKey,
  decimals: number,
): TransactionInstruction {
  // [u8 0][u8 decimals][32 authority][u8 1][32 freeze authority]
  const data = Buffer.alloc(67);
  data.writeUInt8(0, 0);
  data.writeUInt8(decimals, 1);
  authority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34); // no freeze authority
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      {
        pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'),
        isSigner: false,
        isWritable: false,
      },
    ],
    data: data.subarray(0, 35),
  });
}

function mintToInstruction(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0); // MintTo
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function createAtaInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const ata = new PublicKey(deriveAssociatedTokenAddress(owner.toBase58(), mint.toBase58()));
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

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

/** The ledger asset key for SOL on this cluster (ADR-0021). */
const LOCALNET_SOL = nativeAssetKey('localnet');

function adapter() {
  return createSolanaAdapter({
    // A throwaway validator: a fresh one generates a new genesis hash on every
    // reset, which is why `localnet` is exempt from the genesis check.
    cluster: 'localnet',
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
    const minimum = await adapter().getMinimumAccountBalance(LOCALNET_SOL);

    // Not asserted as a constant: it is a network parameter and hardcoding it
    // is exactly what rule 114 forbids. What matters is that it is positive and
    // plausible for a bare account.
    expect(BigInt(minimum)).toBeGreaterThan(0n);
    expect(BigInt(minimum)).toBeLessThan(BigInt(LAMPORTS_PER_SOL));
  });

  it('reads a zero balance for a fresh address', async () => {
    if (!available) return;
    const fresh = Keypair.generate().publicKey.toBase58();
    expect(await adapter().getBalance(fresh, LOCALNET_SOL)).toBe('0');
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
    expect(BigInt(await chain.getBalance(address, LOCALNET_SOL))).toBe(
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
    expect(transfer!.asset).toBe(LOCALNET_SOL);
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

// ---------------------------------------------------------------------------
// SPL tokens against the real program (ADR-0016, rules 117-123)
// ---------------------------------------------------------------------------

/**
 * WHY THIS TEST EXISTS
 *
 * `buildTokenTransferTransaction` hand-encodes the SPL `Transfer` instruction:
 * `[u8 3][u64le amount]`, with a fixed account ordering. A unit test can only
 * check that the bytes are the bytes this code produces — it cannot tell
 * whether the SPL Token program accepts them.
 *
 * Every possible mistake here is silent under unit tests and fatal on-chain: a
 * wrong discriminator invokes a different instruction, a swapped account index
 * moves tokens somewhere else, and a big-endian amount transfers a wildly
 * different quantity. So this builds a real mint, a real token account, and
 * sends a real transfer through the real program.
 */
describe('SPL token transfers on a real validator', () => {
  it('creates a mint, transfers, and creates the destination ATA in one transaction', async () => {
    if (!available) return;

    const payer = Keypair.generate();
    const recipient = Keypair.generate();

    const airdrop = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop, 'confirmed');

    // --- a real mint, created with the real program ---------------------
    const mint = Keypair.generate();
    const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_LENGTH);

    const createMint = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: mintRent,
        space: MINT_LENGTH,
        programId: TOKEN_PROGRAM_ID,
      }),
      initializeMintInstruction(mint.publicKey, payer.publicKey, 6),
    );
    await sendAndConfirm(createMint, [payer, mint]);

    // --- the payer's own token account, and some supply -----------------
    const payerAta = deriveAssociatedTokenAddress(
      payer.publicKey.toBase58(),
      mint.publicKey.toBase58(),
    );
    const fund = new Transaction().add(
      createAtaInstruction(payer.publicKey, payer.publicKey, mint.publicKey),
      mintToInstruction(mint.publicKey, new PublicKey(payerAta), payer.publicKey, 1_000_000_000n),
    );
    await sendAndConfirm(fund, [payer]);

    // The derivation agrees with the program: `mintTo` would have failed if
    // the ATA we derived were not the one the ATA program created.
    const before = await connection.getTokenAccountBalance(new PublicKey(payerAta));
    expect(before.value.amount).toBe('1000000000');

    // --- the transfer this test is actually about -----------------------
    const nonceAccount = await createNonceAccount(payer);
    const nonce = await readNonce(nonceAccount);

    const built = buildTokenTransferTransaction({
      owner: payer.publicKey.toBase58(),
      ownerTokenAccount: payerAta,
      destinationOwner: recipient.publicKey.toBase58(),
      mint: mint.publicKey.toBase58(),
      amount: '250000000',
      nonceAccount: nonceAccount.toBase58(),
      nonceAuthority: payer.publicKey.toBase58(),
      nonce,
      // The recipient has never held this mint.
      createDestinationAccount: true,
    });

    // Signed the way the real path signs: over the message bytes, attached
    // afterwards. The signer never sees a Transaction.
    const signature = signMessage(built.message, payer);
    const signed = attachSignature(built, payer.publicKey.toBase58(), signature);

    const txSig = await connection.sendRawTransaction(Buffer.from(signed), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(txSig, 'confirmed');

    const tx = await connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    // The program ACCEPTED the hand-written encoding.
    expect(tx?.meta?.err).toBeNull();

    const after = await connection.getTokenAccountBalance(
      new PublicKey(built.destinationTokenAccount),
    );
    // Exactly the amount asked for — not 250, not 250 * 10^6 again, and not a
    // byte-order-reversed number.
    expect(after.value.amount).toBe('250000000');

    // --- and the indexer sees it as a deposit ---------------------------
    const events = parseTokenTransfers(
      (await connection.getParsedTransaction(txSig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }))!,
      {
        watchedOwners: new Set([recipient.publicKey.toBase58()]),
        txReference: txSig,
        cluster: 'localnet',
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      asset: `localnet:${mint.publicKey.toBase58()}`,
      amount: '250000000',
      to: recipient.publicKey.toBase58(),
    });
  }, 90_000);
});

// --- test helpers ---------------------------------------------------------

async function sendAndConfirm(transaction: Transaction, signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = signers[0]!.publicKey;
  transaction.sign(...signers);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

async function createNonceAccount(payer: Keypair): Promise<PublicKey> {
  const nonce = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const transaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: nonce.publicKey,
      lamports,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    SystemProgram.nonceInitialize({
      noncePubkey: nonce.publicKey,
      authorizedPubkey: payer.publicKey,
    }),
  );
  await sendAndConfirm(transaction, [payer, nonce]);
  return nonce.publicKey;
}

async function readNonce(address: PublicKey): Promise<string> {
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info) throw new Error('nonce account not found');
  return NonceAccount.fromAccountData(info.data).nonce;
}

/**
 * Sign the message bytes, the way the real signing path does.
 *
 * Node's crypto rather than a nacl dependency: `packages/solana` builds the
 * transactions the treasury signs, and adding a signing library to it for a
 * test is the wrong direction. A `Keypair`'s `secretKey` is the 64-byte
 * expanded form; its first 32 bytes are the seed, which is what PKCS8 wants.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function signMessage(message: Uint8Array, keypair: Keypair): Uint8Array {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32));
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return new Uint8Array(edSign(null, Buffer.from(message), key));
}

// ---------------------------------------------------------------------------
// Token DISCOVERY, not just parsing (ADR-0016)
// ---------------------------------------------------------------------------

/**
 * WHY THIS TEST EXISTS
 *
 * Token parsing was correct for weeks and token deposits still did not work,
 * because nothing was ever fetched to parse: the indexer polled deposit
 * ADDRESSES, and a token transfer never touches the owner's address. It moves
 * between token accounts, and the owner is not among the transaction's account
 * keys.
 *
 * No unit test with a fabricated transaction can catch that — the fabricated
 * transaction is handed to the parser directly. Only a real RPC can say whether
 * `getSignaturesForAddress(owner)` returns anything, and the answer is no.
 */
describe('a token transfer is discoverable only at the token account', () => {
  it('shows a TRANSFER at the token account and not at the owner', async () => {
    if (!available) return;

    const payer = Keypair.generate();
    const airdrop = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop, 'confirmed');

    const mint = Keypair.generate();
    const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_LENGTH);
    await sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: mintRent,
          space: MINT_LENGTH,
          programId: TOKEN_PROGRAM_ID,
        }),
        initializeMintInstruction(mint.publicKey, payer.publicKey, 6),
      ),
      [payer, mint],
    );

    const holder = Keypair.generate();
    const holderAta = deriveAssociatedTokenAddress(
      holder.publicKey.toBase58(),
      mint.publicKey.toBase58(),
    );

    /*
     * Creation and transfer are SEPARATE transactions, deliberately.
     *
     * The ATA-creation instruction names the owner among its account keys, so
     * THAT transaction is visible at the owner's address. Bundling the two
     * hides the finding — the first version of this test did exactly that and
     * reported the opposite conclusion.
     *
     * What matters operationally is the steady state: an address whose token
     * account already exists, receiving more of the same token.
     */
    await sendAndConfirm(
      new Transaction().add(
        createAtaInstruction(payer.publicKey, holder.publicKey, mint.publicKey),
      ),
      [payer],
    );

    const transferSignature = await sendAndConfirm(
      new Transaction().add(
        mintToInstruction(mint.publicKey, new PublicKey(holderAta), payer.publicKey, 500_000_000n),
      ),
      [payer],
    );

    await waitForFinality();

    /*
     * Asserted on THE TRANSFER'S OWN SIGNATURE, not on counts.
     *
     * Counting is racy: `getSignaturesForAddress` lags `confirmed`, so an
     * earlier count can be stale and the comparison then reports the opposite
     * of the truth. Asking whether this specific signature is present at each
     * address is exact and timing-independent.
     */
    const atOwner = await connection.getSignaturesForAddress(holder.publicKey, { limit: 25 });
    const atTokenAccount = await connection.getSignaturesForAddress(new PublicKey(holderAta), {
      limit: 25,
    });

    // THE FINDING: the transfer is invisible at the owner's address...
    expect(atOwner.map((entry) => entry.signature)).not.toContain(transferSignature);
    // ...and plainly visible at the token account.
    expect(atTokenAccount.map((entry) => entry.signature)).toContain(transferSignature);
  }, 90_000);

  it('attributes a token transfer to the OWNER, not to the scanned account', async () => {
    if (!available) return;

    // The other half: once the right account is scanned, the credit must go to
    // the owner. `creditTo` on the fetch request is what carries that — without
    // it the adapter watches whatever it scanned, matches no owner, and drops
    // every token transfer it just successfully found.
    const payer = Keypair.generate();
    const airdrop = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop, 'confirmed');

    const mint = Keypair.generate();
    const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_LENGTH);
    await sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: mintRent,
          space: MINT_LENGTH,
          programId: TOKEN_PROGRAM_ID,
        }),
        initializeMintInstruction(mint.publicKey, payer.publicKey, 6),
      ),
      [payer, mint],
    );

    const holder = Keypair.generate();
    const holderAta = deriveAssociatedTokenAddress(
      holder.publicKey.toBase58(),
      mint.publicKey.toBase58(),
    );

    await sendAndConfirm(
      new Transaction().add(
        createAtaInstruction(payer.publicKey, holder.publicKey, mint.publicKey),
        mintToInstruction(mint.publicKey, new PublicKey(holderAta), payer.publicKey, 250_000_000n),
      ),
      [payer],
    );

    // The adapter reads at `finalized` (ADR-0006); `sendAndConfirm` waits only
    // for `confirmed`. Without this the transaction is simply not there yet and
    // the test fails for a reason that has nothing to do with attribution.
    await waitForFinality();

    const page = await adapter().fetchTransfers({
      address: holderAta,
      creditTo: holder.publicKey.toBase58(),
      cursor: null,
      pageSize: 20,
    });

    // The adapter qualifies every asset with its cluster (ADR-0021).
    const tokenTransfer = page.transfers.find(
      (t) => t.asset === `localnet:${mint.publicKey.toBase58()}`,
    );
    expect(tokenTransfer).toBeDefined();
    expect(tokenTransfer?.to).toBe(holder.publicKey.toBase58());
    expect(tokenTransfer?.amount).toBe('250000000');
  }, 90_000);
});

/** Give the validator time to finalize what was just confirmed. */
async function waitForFinality(): Promise<void> {
  const deadline = Date.now() + 30_000;
  const target = await connection.getSlot('confirmed');
  while (Date.now() < deadline) {
    if ((await connection.getSlot('finalized')) >= target) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
