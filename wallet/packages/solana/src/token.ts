import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import type { Address, TransferEvent } from '@wallet/blockchain';
import { ChainError } from '@wallet/errors';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { ledgerAssetKey, type Cluster } from '@wallet/types';
import { solanaChainId } from './constants.js';
import { toConfirmation } from './rpc.js';
import { toPublicKey } from './rpc.js';

/**
 * SPL token support (ADR-0016, prompt_phase4.md rules 114-127).
 *
 * Confined to this package like everything else chain-specific. The domain sees
 * a `TransferEvent` whose `asset` happens to be a mint address instead of
 * `SOL`, and nothing above the adapter knows the difference — which is the
 * property that let the withdrawal state machine stay untouched.
 */

/** The SPL Token program. */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * The Associated Token Account program.
 *
 * Deliberately NOT supporting Token-2022 (`TokenzQd...`). Its extensions —
 * transfer hooks, transfer fees, confidential transfers — change what a
 * transfer means, and an allowlist that cannot express "this mint charges a fee
 * on transfer" would credit users the wrong amount (ADR-0016).
 */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/** A token account's fixed size, for the rent-exemption query. */
export const TOKEN_ACCOUNT_LENGTH = 165;

/**
 * Derive the Associated Token Account for an owner and mint.
 *
 * The ATA is a PDA, so it is derived rather than stored: given an owner and a
 * mint the address is a pure function, and recomputing it is always correct
 * where reading a cached copy might not be.
 */
export function deriveAssociatedTokenAddress(owner: Address, mint: string): Address {
  const [address] = PublicKey.findProgramAddressSync(
    [toPublicKey(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), toPublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address.toBase58();
}

export interface ParseTokenOptions {
  /** Which cluster these bytes came from. See `ParseOptions.cluster`. */
  readonly cluster: Cluster;
  /**
   * Deposit addresses to watch — the OWNERS, not their token accounts.
   *
   * Watching owners rather than ATAs is what makes a new mint free: an owner
   * receiving a token they have never held before is detected without having
   * derived that ATA in advance. Watching ATAs would require deriving one per
   * (address, mint) pair up front and would miss every mint not anticipated.
   */
  readonly watchedOwners: ReadonlySet<Address>;
  readonly txReference: string;
}

/**
 * Turn token balance movements into `TransferEvent`s.
 *
 * WHY BALANCE DELTAS, AGAIN
 *
 * The same argument as `parseTransfers` for SOL: `preTokenBalances` and
 * `postTokenBalances` are the chain's own accounting and capture every path a
 * token can arrive by — a plain transfer, a CPI, a swap, a program that pays
 * out. Matching on the `spl-token::transfer` instruction would credit some
 * arrivals and silently ignore others.
 *
 * ONE THING IS BETTER HERE THAN FOR SOL
 *
 * `uiTokenAmount.amount` arrives from the RPC as a STRING, not a number, so the
 * 2^53 precision ceiling documented in `transfers.ts` does not apply. An
 * 18-decimal token with a large balance survives this path intact. Converting
 * it to a number anywhere would reintroduce the bug that string exists to
 * avoid.
 *
 * THE UNIQUENESS KEY STILL HOLDS
 *
 * `instructionIndex` carries the TOKEN ACCOUNT's index in the transaction's
 * account keys. A transaction moving SOL and a token to one owner produces two
 * events with different indices — the owner's own account index for the SOL,
 * the ATA's for the token — so `(chain, tx_signature, instruction_index)`
 * separates them without change (rule 123).
 */
export function parseTokenTransfers(
  transaction: ParsedTransactionWithMeta,
  options: ParseTokenOptions,
): TransferEvent[] {
  const meta = transaction.meta;
  if (!meta) return [];

  // A failed transaction moves nothing.
  if (meta.err !== null) return [];

  const post = meta.postTokenBalances ?? [];
  const pre = meta.preTokenBalances ?? [];
  if (post.length === 0) return [];

  // Keyed by account index: the same token account appears at most once in
  // each array, and an account absent from `pre` simply started at zero.
  const before = new Map(pre.map((entry) => [entry.accountIndex, entry]));

  const events: TransferEvent[] = [];
  const confirmation = toConfirmation('finalized');
  const position = BigInt(transaction.slot);

  for (const entry of post) {
    const owner = entry.owner;
    if (owner === undefined || !options.watchedOwners.has(owner)) continue;

    // Only the canonical SPL Token program. A Token-2022 account reaching here
    // is not credited; see ASSOCIATED_TOKEN_PROGRAM_ID.
    if (entry.programId !== undefined && entry.programId !== TOKEN_PROGRAM_ID.toBase58()) {
      continue;
    }

    const priorAmount = before.get(entry.accountIndex)?.uiTokenAmount.amount ?? '0';
    // Strings throughout. Never Number().
    const delta = BigInt(entry.uiTokenAmount.amount) - BigInt(priorAmount);
    if (delta <= 0n) continue;

    events.push({
      chain: solanaChainId(options.cluster),
      // The MINT is the asset key, not the symbol (ADR-0016) — qualified by
      // the cluster, because the same mint address on devnet and mainnet is
      // two different assets with two different values (ADR-0021).
      asset: ledgerAssetKey(options.cluster, entry.mint),
      amount: delta.toString(),
      to: owner,
      from: null,
      txReference: options.txReference,
      instructionIndex: entry.accountIndex,
      position,
      confirmation,
      metadata: {
        tokenAccount: accountKeyAt(transaction, entry.accountIndex) ?? '',
        // Decimals travel as metadata — the domain never reads them, and they
        // are display-only (master-prompt rule 115).
        decimals: String(entry.uiTokenAmount.decimals),
      },
    });
  }

  return events;
}

function accountKeyAt(transaction: ParsedTransactionWithMeta, index: number): string | undefined {
  return transaction.transaction.message.accountKeys[index]?.pubkey.toBase58();
}

/**
 * The amount of a token account's balance that may be swept.
 *
 * A token account holds no lamports of its own beyond its rent-exempt
 * minimum, and that minimum is denominated in SOL, not in the token — so
 * unlike a SOL deposit address, the whole token balance is sweepable. The
 * constraint that bites instead is the SOL fee, which the account cannot pay
 * with tokens (rule 119) and which `fundFee` handles.
 */
export function sweepableTokenAmount(balance: string): string {
  const amount = BigInt(balance);
  if (amount < 0n) {
    throw new ChainError(`Token balance cannot be negative: ${balance}`);
  }
  return amount.toString();
}

// ---------------------------------------------------------------------------
// Building token transactions (ADR-0016, prompt_phase4.md rules 117-121)
// ---------------------------------------------------------------------------

/**
 * The SPL Token `Transfer` instruction.
 *
 * Hand-encoded rather than pulling in `@solana/spl-token`. The layout is three
 * fields and has not changed since the program shipped; the dependency brings a
 * large transitive tree into the package that builds transactions the treasury
 * signs, and `bigint-buffer` — already a live advisory in this project — is in
 * that tree.
 *
 * Layout: `[u8 instruction = 3][u64le amount]`.
 *
 * Deliberately `Transfer` (3) and not `TransferChecked` (12): `TransferChecked`
 * takes the mint and its decimals as arguments, and decimals are display
 * metadata that must never enter arithmetic (master-prompt rule 115). Passing
 * them to the chain invites treating them as significant.
 */
function encodeTransferInstruction(amount: bigint): Buffer {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amount, 1);
  return data;
}

/** The ATA program's `Create` instruction takes no data. */
const CREATE_ATA_DATA = Buffer.alloc(0);

export interface BuildTokenTransferInput {
  /** The OWNER whose tokens move, and who signs for them — not its token account. */
  readonly owner: string;
  /**
   * Who pays the network fee and any ATA rent. Defaults to `owner`.
   *
   * For a user withdrawal this is the house (ADR-0020 §3): a token account
   * holds no SOL of its own, so a segregated user address would otherwise be
   * unable to move its own tokens. When it differs from `owner` the
   * transaction has two signers.
   */
  readonly feePayer?: string | undefined;
  readonly ownerTokenAccount: string;
  readonly destinationOwner: string;
  readonly mint: string;
  /** Base units of the TOKEN. Never scaled by decimals. */
  readonly amount: string;
  readonly nonceAccount: string;
  readonly nonceAuthority: string;
  readonly nonce: string;
  /**
   * True when the destination's ATA does not exist yet and must be created in
   * the same transaction.
   *
   * The caller establishes this by reading the chain; it is not assumed,
   * because creating an account that already exists fails the whole
   * transaction, and not creating one that is missing fails it too.
   */
  readonly createDestinationAccount: boolean;
}

/**
 * Build an SPL token transfer on a durable nonce.
 *
 * Same lifecycle as a SOL withdrawal, same nonce discipline, same single-use
 * property (ADR-0009) — which is the point. If a token withdrawal could not
 * reuse the withdrawal state machine, the state machine would be
 * chain-specific and that would be the defect (rule 126).
 *
 * NOTE ON THE FEE: the fee payer defaults to `owner`, who must then hold SOL.
 * A token account holds no SOL of its own, so where `owner` pays, a funding
 * step must already have run (rule 119) — an unfunded transfer fails at
 * broadcast, after signing, having consumed a nonce. A user withdrawal avoids
 * that entirely by naming the house as `feePayer` (ADR-0020 §3), which is also
 * what makes a token-only balance spendable without the user holding SOL.
 */
export function buildTokenTransferTransaction(input: BuildTokenTransferInput): {
  readonly message: Uint8Array;
  readonly transaction: Transaction;
  readonly nonce: string;
  readonly destinationTokenAccount: string;
  readonly signers: readonly string[];
} {
  const amount = BigInt(input.amount);
  if (amount <= 0n) {
    throw new ChainError('Token transfer amount must be positive');
  }
  // u64, the chain's own ceiling. Unlike lamports there is no 2^53 problem
  // here: the amount is encoded as bytes, never through a JS number.
  if (amount > 0xffff_ffff_ffff_ffffn) {
    throw new ChainError('Token transfer amount exceeds u64');
  }

  const destinationTokenAccount = deriveAssociatedTokenAddress(input.destinationOwner, input.mint);

  const feePayer = input.feePayer ?? input.owner;

  const transaction = new Transaction({
    feePayer: toPublicKey(feePayer),
    nonceInfo: {
      nonce: input.nonce,
      nonceInstruction: SystemProgram.nonceAdvance({
        noncePubkey: toPublicKey(input.nonceAccount),
        authorizedPubkey: toPublicKey(input.nonceAuthority),
      }),
    },
  });

  if (input.createDestinationAccount) {
    // Rent for this account is the platform's expense, credited to house_rent
    // and never to the user (rule 118, `postTokenAccountRent`).
    transaction.add({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        // The FUNDING account, which is charged the rent — the fee payer, so
        // rent lands on house_rent exactly as `postTokenAccountRent` records
        // it, and never on the user whose tokens are moving.
        { pubkey: toPublicKey(feePayer), isSigner: true, isWritable: true },
        { pubkey: toPublicKey(destinationTokenAccount), isSigner: false, isWritable: true },
        { pubkey: toPublicKey(input.destinationOwner), isSigner: false, isWritable: false },
        { pubkey: toPublicKey(input.mint), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: CREATE_ATA_DATA,
    });
  }

  transaction.add({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: toPublicKey(input.ownerTokenAccount), isSigner: false, isWritable: true },
      { pubkey: toPublicKey(destinationTokenAccount), isSigner: false, isWritable: true },
      { pubkey: toPublicKey(input.owner), isSigner: true, isWritable: false },
    ],
    data: encodeTransferInstruction(amount),
  });

  return {
    message: new Uint8Array(transaction.serializeMessage()),
    transaction,
    nonce: input.nonce,
    destinationTokenAccount,
    signers: [...new Set([feePayer, input.owner, input.nonceAuthority])],
  };
}

export interface FeeFundingInput {
  readonly from: string;
  readonly to: string;
  readonly lamports: string;
  readonly nonceAccount: string;
  readonly nonceAuthority: string;
  readonly nonce: string;
}

/**
 * Fund an address with SOL so it can pay for a token transfer (rules 119-121).
 *
 * A SEPARATE transaction from the transfer it enables, deliberately. Combining
 * them would mean the hot wallet pays the fee for a transaction that also moves
 * a deposit address's tokens — putting two key classes into one signature and
 * dissolving the boundary ADR-0005 depends on.
 *
 * This is a house expense with its own funding path (`postHouseFunding`), not
 * a deduction from the user's balance.
 */
export function buildFeeFundingTransaction(input: FeeFundingInput): {
  readonly message: Uint8Array;
  readonly transaction: Transaction;
  readonly nonce: string;
} {
  const lamports = BigInt(input.lamports);
  if (lamports <= 0n) {
    throw new ChainError('Fee funding amount must be positive');
  }
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ChainError('Fee funding amount exceeds the SDK precision ceiling');
  }

  const transaction = new Transaction({
    feePayer: toPublicKey(input.from),
    nonceInfo: {
      nonce: input.nonce,
      nonceInstruction: SystemProgram.nonceAdvance({
        noncePubkey: toPublicKey(input.nonceAccount),
        authorizedPubkey: toPublicKey(input.nonceAuthority),
      }),
    },
  });

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: toPublicKey(input.from),
      toPubkey: toPublicKey(input.to),
      lamports: Number(lamports),
    }),
  );

  return {
    message: new Uint8Array(transaction.serializeMessage()),
    transaction,
    nonce: input.nonce,
  };
}

export interface SweepPlan {
  readonly shouldSweep: boolean;
  /** Base units to move. Zero when `shouldSweep` is false. */
  readonly amount: string;
  readonly reason: string;
}

/**
 * How much of a SOL balance may be swept (ADR-0017, rule 133).
 *
 * NEVER the rent-exempt minimum. A swept-to-zero account ceases to exist, and
 * the next deposit to it pays to recreate it — so the "recoverable value" that
 * sweeping the minimum appears to release is spent again immediately, plus a
 * transaction fee.
 *
 * Below the threshold nothing moves: sweeping dust costs more in fees than it
 * consolidates, and an attacker who can make us sweep on demand by sending dust
 * can make us pay fees on demand.
 */
export function planNativeSweep(input: {
  readonly balance: string;
  readonly rentExemptMinimum: string;
  readonly feeReserve: string;
  readonly threshold: string;
}): SweepPlan {
  const balance = BigInt(input.balance);
  const reserved = BigInt(input.rentExemptMinimum) + BigInt(input.feeReserve);

  if (balance <= reserved) {
    return {
      shouldSweep: false,
      amount: '0',
      reason: 'balance_at_or_below_reserved_minimum',
    };
  }

  const sweepable = balance - reserved;
  if (sweepable < BigInt(input.threshold)) {
    return { shouldSweep: false, amount: '0', reason: 'below_sweep_threshold' };
  }

  return { shouldSweep: true, amount: sweepable.toString(), reason: 'sweepable' };
}
