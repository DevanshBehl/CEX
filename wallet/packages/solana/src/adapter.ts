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
import { parseLedgerAssetKey, type Cluster } from '@wallet/types';
import { createSolanaAddressValidator } from './address.js';
import { NATIVE_ASSET, solanaChainId } from './constants.js';
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
  /**
   * Which cluster this adapter reads.
   *
   * One adapter per cluster, never one adapter asked which cluster to use:
   * the endpoint, the genesis hash, the asset keys it emits and the `chain`
   * value it stamps all belong to the same cluster, and a parameter would let
   * three of them agree while the fourth did not.
   */
  readonly cluster: Cluster;
}

/**
 * The Solana implementation of the read half of `ChainAdapter`
 * (prompt_phase2.md rules 102, 111-115).
 */
export function createSolanaAdapter(options: SolanaAdapterOptions): ChainAdapter {
  const rpc = createSolanaRpc(options);
  const validator = createSolanaAddressValidator();

  const chain = solanaChainId(options.cluster);

  /**
   * Reject a key from another cluster rather than answering for this one.
   *
   * The failure this prevents: reconciliation reading a mainnet position for a
   * devnet account key and reporting a shortfall — or worse, a match.
   */
  function nativeAmountKey(assetKey: string): void {
    const parsed = parseLedgerAssetKey(assetKey);
    if (parsed.cluster !== options.cluster) {
      throw new ChainError(
        `asset ${assetKey} belongs to ${parsed.cluster}; this adapter serves ${options.cluster}`,
      );
    }
    if (parsed.asset !== NATIVE_ASSET) {
      // ADR-0008: SOL only for balance reads. Failing loudly beats returning
      // zero, which reconciliation would read as a shortfall.
      throw new ChainError(`Unsupported asset for Solana in this phase: ${assetKey}`);
    }
  }

  return {
    chain,
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

      /*
       * Who to credit, which is not always what was scanned.
       *
       * A token account's inbound transfers are found by scanning the token
       * account, but they belong to its OWNER — and `parseTokenTransfers`
       * matches on owner precisely so a mint nobody anticipated is still
       * attributed. Passing the scanned account here instead would match
       * nothing, and token deposits would be discovered and then silently
       * dropped (ADR-0016).
       */
      const watchedOwners = new Set<Address>([
        validator.normalize(request.creditTo ?? request.address),
      ]);
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
          ...parseTransfers(parsed, {
            watchedAddresses,
            txReference: entry.signature,
            cluster: options.cluster,
          }),
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
            watchedOwners,
            txReference: entry.signature,
            cluster: options.cluster,
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
      nativeAmountKey(asset);
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
      nativeAmountKey(asset);
      const lamports = await rpc.call('getMinimumBalanceForRentExemption', (connection) =>
        // 0 bytes of data: a plain keypair account, which is what a deposit
        // address is.
        connection.getMinimumBalanceForRentExemption(0, options.commitment),
      );
      return BigInt(lamports).toString();
    },

    /**
     * Does this account exist on chain?
     *
     * The token path asks before deciding whether to include an
     * ATA-creation instruction: creating one that exists fails the whole
     * transaction, and omitting one that is missing fails it too (ADR-0016).
     */
    async accountExists(address: string): Promise<boolean> {
      const info = await rpc.call('getAccountInfo(exists)', (connection) =>
        connection.getAccountInfo(toPublicKey(address), options.commitment),
      );
      return info !== null;
    },

    /**
     * The cluster's genesis hash — Solana's network identity.
     *
     * Cheap and cacheable, but deliberately NOT cached here: it is called once
     * at boot, and a cache would hide an endpoint that was swapped underneath a
     * long-running process.
     */
    async getNetworkIdentity(): Promise<string> {
      return rpc.call('getGenesisHash', (connection) => connection.getGenesisHash());
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
