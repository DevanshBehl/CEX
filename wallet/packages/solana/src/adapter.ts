import type { Commitment } from '@solana/web3.js';
import { ChainError } from '@wallet/errors';
import type {
  Address,
  ChainAdapter,
  ChainPosition,
  Confirmation,
  FetchTransfersRequest,
  TransferEvent,
  TransferPage,
  TxReference,
} from '@wallet/blockchain';
import { createSolanaAddressValidator } from './address.js';
import { NATIVE_ASSET, SOLANA_CHAIN_ID } from './constants.js';
import {
  createSolanaRpc,
  toConfirmation,
  toFinality,
  toPublicKey,
  type RpcOptions,
} from './rpc.js';
import { parseTransfers } from './transfers.js';
import { parseTokenTransfers } from './token.js';

export interface SolanaAdapterOptions extends RpcOptions {
  /** Signatures fetched per page. Bounded by the RPC at 1000. */
  readonly pageSize: number;
}

/**
 * The Solana implementation of the read half of `ChainAdapter`
 * (prompt_phase2.md rules 102, 111-115).
 */
export function createSolanaAdapter(options: SolanaAdapterOptions): ChainAdapter {
  const rpc = createSolanaRpc(options);
  const validator = createSolanaAddressValidator();

  return {
    chain: SOLANA_CHAIN_ID,
    validator,

    /**
     * A page of transfers to one address, OLDEST FIRST.
     *
     * `getSignaturesForAddress` returns newest-first and pages backwards via
     * `before`. The indexer needs the opposite: it walks forward from a cursor
     * so that "everything before the cursor is committed" stays true, which is
     * what makes a restart safe (rules 145-147).
     *
     * So this walks backwards from the tip until it reaches the cursor, then
     * reverses. The consequence worth knowing: catching up from a very old
     * cursor costs several round trips, which is fine for an address that is
     * polled regularly and slow for one that has been unwatched for a long
     * time.
     */
    async fetchTransfers(request: FetchTransfersRequest): Promise<TransferPage> {
      const pubkey = toPublicKey(request.address);
      const limit = Math.min(request.pageSize ?? options.pageSize, 1000);

      const signatures = await rpc.call('getSignaturesForAddress', (connection) =>
        connection.getSignaturesForAddress(
          pubkey,
          {
            limit,
            // `until` stops the backwards walk once we reach known history.
            ...(request.cursor !== null ? { until: request.cursor } : {}),
          },
          // getSignaturesForAddress accepts only Finality, not Commitment:
          // there is no such thing as a `processed` signature listing.
          toFinality(options.commitment),
        ),
      );

      if (signatures.length === 0) {
        return { transfers: [], nextCursor: request.cursor, hasMore: false };
      }

      // Only finalized, successful transactions are eligible (ADR-0006).
      // A signature that has not reached the required commitment is left for a
      // later poll rather than credited early.
      const eligible = signatures
        .filter((entry) => entry.err === null)
        .filter((entry) => meetsCommitment(entry.confirmationStatus, options.commitment));

      // Reverse to oldest-first before parsing, so the cursor advances forward.
      const ordered = [...eligible].reverse();

      const watchedAddresses = new Set<Address>([validator.normalize(request.address)]);
      const transfers: TransferEvent[] = [];

      for (const entry of ordered) {
        const parsed = await rpc.call('getParsedTransaction', (connection) =>
          connection.getParsedTransaction(entry.signature, {
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
          }),
        );
        if (!parsed) continue;
        transfers.push(
          ...parseTransfers(parsed, { watchedAddresses, txReference: entry.signature }),
        );
        /**
         * Token movements come from the same transaction and the same watched
         * addresses, but from a different part of the metadata (ADR-0016).
         *
         * One transaction can therefore yield BOTH a SOL event and a token
         * event for the same address. They carry different
         * `instructionIndex` values — the address's own account index against
         * the token account's — so the `(chain, tx, index)` uniqueness key
         * keeps them as two deposits, which is what rule 123 asks for.
         *
         * Whether a mint is allowlisted is NOT decided here. The adapter
         * reports what the chain did; crediting is the indexer's decision,
         * and an unrecognised mint has to reach it in order to be recorded as
         * ignored rather than silently dropped (rule 124).
         */
        transfers.push(
          ...parseTokenTransfers(parsed, {
            watchedOwners: watchedAddresses,
            txReference: entry.signature,
          }),
        );
      }

      // The newest signature we successfully examined becomes the next cursor.
      // Taken from `ordered`, not from `signatures`, so a page whose newest
      // entries were not yet finalized does not advance past them.
      const newest = ordered.at(-1)?.signature ?? request.cursor;

      return {
        transfers,
        nextCursor: newest,
        // A full page implies there may be more history between the cursor and
        // the tip; the caller polls again rather than looping here.
        hasMore: signatures.length >= limit,
      };
    },

    async getBalance(address: Address, asset: string): Promise<string> {
      if (asset !== NATIVE_ASSET) {
        // ADR-0008: SOL only in Phase 2. Failing loudly beats returning zero,
        // which reconciliation would read as a shortfall.
        throw new ChainError(`Unsupported asset for Solana in this phase: ${asset}`);
      }
      const lamports = await rpc.call('getBalance', (connection) =>
        connection.getBalance(toPublicKey(address), options.commitment),
      );
      return BigInt(lamports).toString();
    },

    async getConfirmation(reference: TxReference): Promise<Confirmation> {
      const statuses = await rpc.call('getSignatureStatuses', (connection) =>
        connection.getSignatureStatuses([reference], { searchTransactionHistory: true }),
      );
      const status = statuses.value[0];
      if (!status) return 'seen';
      if (status.err !== null) return 'seen';
      return toConfirmation(status.confirmationStatus);
    },

    async getPosition(): Promise<ChainPosition> {
      const slot = await rpc.call('getSlot', (connection) =>
        connection.getSlot(options.commitment),
      );
      return BigInt(slot);
    },

    /**
     * The rent-exempt minimum, read from the chain rather than hardcoded
     * (prompt_phase2.md rule 114).
     *
     * It is a network parameter. A stale constant here would misattribute the
     * difference between a user's spendable balance and `house_rent`, which is
     * the one number this phase must not get wrong.
     */
    async getMinimumAccountBalance(asset: string): Promise<string> {
      if (asset !== NATIVE_ASSET) {
        throw new ChainError(`Unsupported asset for Solana in this phase: ${asset}`);
      }
      const lamports = await rpc.call('getMinimumBalanceForRentExemption', (connection) =>
        // 0 bytes of data: a plain keypair account, which is what a deposit
        // address is.
        connection.getMinimumBalanceForRentExemption(0, options.commitment),
      );
      return BigInt(lamports).toString();
    },

    async isHealthy(): Promise<boolean> {
      try {
        await rpc.call('getSlot', (connection) => connection.getSlot('processed'));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Is this signature settled enough for the configured policy? */
function meetsCommitment(
  status: 'processed' | 'confirmed' | 'finalized' | null | undefined,
  required: Commitment,
): boolean {
  const rank = { processed: 0, confirmed: 1, finalized: 2 } as const;
  const requiredRank =
    required === 'finalized' || required === 'max' || required === 'root'
      ? 2
      : required === 'confirmed' || required === 'single' || required === 'singleGossip'
        ? 1
        : 0;
  if (status === null || status === undefined) return false;
  return rank[status] >= requiredRank;
}
