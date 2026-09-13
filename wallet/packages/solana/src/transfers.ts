import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import type { Address, TransferEvent } from '@wallet/blockchain';
import type { Cluster } from '@wallet/types';
import { nativeAssetKey, solanaChainId } from './constants.js';
import { toConfirmation } from './rpc.js';

/**
 * Turning a confirmed transaction into `TransferEvent`s
 * (prompt_phase2.md rules 111-112).
 *
 * WHY BALANCE DELTAS AND NOT INSTRUCTION PARSING
 *
 * The obvious approach is to walk the instructions and pick out
 * `system::transfer`. It is also wrong, and quietly so. SOL reaches an address
 * through several paths: a plain transfer, a `transferWithSeed`, a CPI from any
 * program, an account closure refunding rent, a `createAccount` that funds the
 * new account. An indexer that recognises only `system::transfer` credits some
 * deposits and silently ignores others, and the ones it ignores are not
 * obviously a category — they are just missing money.
 *
 * `preBalances`/`postBalances` are the chain's own accounting for the whole
 * transaction and capture every path at once. If an address ends up with more
 * lamports than it started with, it received that much, whatever the mechanism.
 *
 * The cost is that one transaction yields at most one event per address, so
 * `instructionIndex` is not a real instruction index — see below.
 *
 * KNOWN LIMITATION: PRECISION ABOVE 2^53
 *
 * `preBalances` and `postBalances` arrive from the RPC as JavaScript `number`s,
 * because @solana/web3.js parses the JSON-RPC response with `JSON.parse`. A
 * lamport balance above 2^53 (about 9,007,199 SOL) has therefore ALREADY lost
 * precision by the time this function runs, and converting to bigint here
 * cannot recover it.
 *
 * This is a property of the SDK, not of this code. It does not affect Phase 2:
 * deposit addresses hold one user's balance and never approach that magnitude.
 * It WOULD affect a hot wallet at scale, and the fix is a custom RPC transport
 * that parses the response with bigint support. Recorded here rather than
 * discovered later, and covered by a test that documents the behaviour.
 */

export interface ParseOptions {
  /** Only these addresses produce events. */
  readonly watchedAddresses: ReadonlySet<Address>;
  readonly txReference: string;
  /**
   * Which cluster these bytes came from.
   *
   * Required, not defaulted. An event carrying a bare `SOL` would credit a
   * ledger account that spans clusters, and devnet play money would add to a
   * mainnet balance with every invariant still passing (ADR-0021).
   */
  readonly cluster: Cluster;
}

/**
 * `instructionIndex` carries the account index within the transaction's account
 * keys, not an instruction position.
 *
 * The uniqueness key is `(chain, tx_signature, instruction_index)`
 * (prompt_phase2.md rule 127), and what it has to guarantee is one row per
 * (transaction, credited address). The account index does exactly that: it is
 * stable, unique per address within a transaction, and reproducible on a replay.
 * Using a real instruction index would break the guarantee, because a net
 * credit produced by three instructions has no single index to point at.
 *
 * The field keeps its interface name because the domain's contract is "a
 * discriminator within the transaction", which this is.
 */
export function parseTransfers(
  transaction: ParsedTransactionWithMeta,
  options: ParseOptions,
): TransferEvent[] {
  const meta = transaction.meta;
  if (!meta) return [];

  // A failed transaction moves nothing. Crediting one would be crediting money
  // that was never sent.
  if (meta.err !== null) return [];

  const accountKeys = transaction.transaction.message.accountKeys;
  const { preBalances, postBalances } = meta;
  if (preBalances.length !== postBalances.length) return [];

  const events: TransferEvent[] = [];
  const confirmation = toConfirmation('finalized');
  const position = BigInt(transaction.slot);

  // The fee payer's delta includes the fee it paid. Irrelevant for deposits
  // (we are never the fee payer on an incoming transfer) but recorded here so
  // the omission is deliberate rather than forgotten.
  const feePayer = accountKeys[0]?.pubkey.toBase58();

  for (let index = 0; index < accountKeys.length; index += 1) {
    const key = accountKeys[index];
    if (!key) continue;

    const address = key.pubkey.toBase58();
    if (!options.watchedAddresses.has(address)) continue;

    const before = preBalances[index];
    const after = postBalances[index];
    if (before === undefined || after === undefined) continue;

    // Numbers from the RPC, converted to bigint immediately and never used in
    // arithmetic as numbers. A lamport balance can exceed 2^53.
    const delta = BigInt(after) - BigInt(before);
    if (delta <= 0n) continue;

    events.push({
      chain: solanaChainId(options.cluster),
      asset: nativeAssetKey(options.cluster),
      amount: delta.toString(),
      to: address,
      from: inferSender(accountKeys, preBalances, postBalances, index),
      txReference: options.txReference,
      instructionIndex: index,
      position,
      confirmation,
      ...(feePayer !== undefined ? { metadata: { feePayer } } : {}),
    });
  }

  return events;
}

/**
 * Best-effort sender attribution, for display only.
 *
 * Picks the account that lost the most lamports. This is a heuristic and is
 * wrong for multi-input transactions — which is acceptable because nothing
 * depends on it: attribution to a USER is by destination address
 * (prompt_phase2.md rule 151), and this value is never used for that.
 */
function inferSender(
  accountKeys: ParsedTransactionWithMeta['transaction']['message']['accountKeys'],
  preBalances: number[],
  postBalances: number[],
  excludeIndex: number,
): string | null {
  let sender: string | null = null;
  let largestDecrease = 0n;

  for (let index = 0; index < accountKeys.length; index += 1) {
    if (index === excludeIndex) continue;
    const before = preBalances[index];
    const after = postBalances[index];
    const key = accountKeys[index];
    if (before === undefined || after === undefined || !key) continue;

    const decrease = BigInt(before) - BigInt(after);
    if (decrease > largestDecrease) {
      largestDecrease = decrease;
      sender = key.pubkey.toBase58();
    }
  }

  return sender;
}
