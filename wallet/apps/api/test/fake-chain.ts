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
import {
  createSolanaAddressValidator,
  GENESIS_HASHES,
  nativeAssetKey,
  solanaChainId,
} from '@wallet/solana';
import type { Cluster } from '@wallet/types';
import { TEST_CLUSTER } from './helpers.js';

/**
 * A chain the tests control completely.
 *
 * Restart safety and idempotency are properties of ORDERING — what is
 * committed before what — and proving them needs the ability to stop the world
 * at an exact point, replay a page, and reorder events. A real validator
 * cannot be asked to do that; a fake can.
 *
 * The Solana adapter's own parsing and validation are covered by its unit
 * tests and by the localnet integration test, so nothing is lost by faking the
 * transport here.
 */
export interface FakeChain extends ChainAdapter {
  /** Queue a transfer that the next poll of `to` will return. */
  push(transfer: Partial<TransferEvent> & { to: Address; amount: string }): TransferEvent;
  setMinimumAccountBalance(lamports: string): void;
  setBalance(address: Address, lamports: string): void;
  /**
   * Move an existing transfer to `final`, the way a real chain does.
   *
   * A transfer is one event whose confirmation level RISES; it is not two
   * events. Modelling it as two appended rows would let a test pass while the
   * indexer permanently skipped the pending one.
   */
  finalize(txReference: string): void;
  /** Make the next N fetches for one address throw. */
  failNextFetchesFor(address: Address, count: number): void;
  fetchCount(): number;
}

export interface FakeChainOptions {
  /**
   * Which cluster this fake claims to be.
   *
   * The boot-time genesis check compares what the endpoint reports against
   * the cluster it is configured as, so a fake standing in for devnet has to
   * report devnet's genesis hash or the server refuses to start — correctly,
   * because that check exists to catch a URL that does not serve the network
   * it is labelled with.
   */
  readonly cluster?: Cluster;
}

export function createFakeChain(options: FakeChainOptions = {}): FakeChain {
  const cluster = options.cluster ?? TEST_CLUSTER;
  const chainId = solanaChainId(cluster);
  const nativeKey = nativeAssetKey(cluster);
  const validator = createSolanaAddressValidator();
  const byAddress = new Map<string, TransferEvent[]>();
  const balances = new Map<string, string>();
  let minimum = '890880';
  const failuresByAddress = new Map<string, number>();
  let sequence = 0;
  let fetches = 0;

  return {
    // Cluster-qualified, like the real adapter (ADR-0021). A bare `SOL` here
    // would credit a ledger account no cluster-scoped query can see.
    chain: chainId,
    validator,

    push(input) {
      sequence += 1;
      const transfer: TransferEvent = {
        chain: chainId,
        asset: nativeKey,
        from: null,
        txReference: input.txReference ?? `sig-${sequence}`,
        instructionIndex: input.instructionIndex ?? 1,
        position: input.position ?? BigInt(1000 + sequence),
        confirmation: input.confirmation ?? 'final',
        ...input,
      };
      const existing = byAddress.get(transfer.to) ?? [];
      existing.push(transfer);
      byAddress.set(transfer.to, existing);
      return transfer;
    },

    setMinimumAccountBalance(lamports) {
      minimum = lamports;
    },

    setBalance(address, lamports) {
      balances.set(address, lamports);
    },

    finalize(txReference) {
      for (const transfers of byAddress.values()) {
        for (let i = 0; i < transfers.length; i += 1) {
          const transfer = transfers[i];
          if (transfer?.txReference === txReference) {
            transfers[i] = { ...transfer, confirmation: 'final' };
          }
        }
      }
    },

    failNextFetchesFor(address, count) {
      failuresByAddress.set(address, count);
    },

    fetchCount() {
      return fetches;
    },

    async fetchTransfers(request: FetchTransfersRequest): Promise<TransferPage> {
      fetches += 1;
      const remaining = failuresByAddress.get(request.address) ?? 0;
      if (remaining > 0) {
        failuresByAddress.set(request.address, remaining - 1);
        throw new Error('simulated RPC failure');
      }

      const all = byAddress.get(request.address) ?? [];

      // Resume after the cursor, mirroring what a real source does.
      const startIndex =
        request.cursor === null ? 0 : all.findIndex((t) => t.txReference === request.cursor) + 1;

      const page = all.slice(startIndex, startIndex + request.pageSize);
      return {
        transfers: page,
        nextCursor: page.at(-1)?.txReference ?? request.cursor,
        hasMore: startIndex + page.length < all.length,
      };
    },

    async getBalance(address: Address): Promise<string> {
      return balances.get(address) ?? '0';
    },

    async getConfirmation(_reference: TxReference): Promise<Confirmation> {
      return 'final';
    },

    async getPosition(): Promise<ChainPosition> {
      return BigInt(1000 + sequence);
    },

    async getMinimumAccountBalance(): Promise<string> {
      return minimum;
    },

    /**
     * Every account "exists" on the fake chain.
     *
     * Deliberate: the token path uses this to decide whether to include an
     * ATA-creation instruction, and the fake chain models nothing about
     * account lifecycles. Returning true means the tests exercise the simpler
     * branch — the branch that CREATES an account is only meaningfully tested
     * against a real validator, which `packages/solana` does.
     */
    async accountExists(): Promise<boolean> {
      return true;
    },

    /**
     * A localnet-shaped identity, so the boot check skips verification the way
     * it does against a real local validator. The tests run with
     * `SOLANA_NETWORK=localnet`, which has no constant genesis hash.
     */
    async getNetworkIdentity(): Promise<string> {
      // What a real endpoint for this cluster would report. `localnet` has no
      // constant — a fresh validator generates a new genesis on every reset —
      // so the check skips it and any string will do.
      return GENESIS_HASHES[cluster] ?? 'fake-chain-genesis';
    },

    async isHealthy(): Promise<boolean> {
      return true;
    },
  };
}
