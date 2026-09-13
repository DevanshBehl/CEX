import type { ChainReader } from '@wallet/blockchain';
import type { PrismaClient } from '@wallet/db';
import { postSweepFee, toAmount } from '@wallet/ledger';
import type { Logger } from '@wallet/logger';
import type { SweepPlan } from '@wallet/solana';
import type { AssetRegistry } from '@wallet/types';

/**
 * Sweeps — DISABLED under segregated custody (ADR-0020).
 *
 * # Why this code still exists but is not wired
 *
 * A sweep consolidates user deposit addresses into a pooled hot wallet. That is
 * correct for an omnibus exchange and is **exactly the act segregated custody
 * rules out**: the moment funds pool, one user's balance stops being
 * identifiable on-chain, and the bankruptcy-remoteness and per-user
 * reconciliation that segregation exists to provide are both gone.
 *
 * So nothing calls this. It is not registered as a worker, and
 * `apps/api/src/server.ts` never constructs it.
 *
 * It is RETAINED rather than deleted because the hard part was never the
 * mechanics — it was the accounting. `postSweepFee` establishes that a transfer
 * between two platform-owned addresses posts **only its fee**, because the
 * ledger has one `chain_assets` account per (owner, asset) and moving value
 * between two addresses of the same owner is not an entry. Rebalancing between
 * HOUSE tiers (ADR-0018) is still a real future need and has precisely that
 * shape. Deleting this would mean rediscovering it.
 *
 * # If you are about to re-enable this
 *
 * Do not, for user addresses. Check ADR-0020 first. If the requirement has
 * genuinely changed back to an omnibus model, that is an ADR, not a wiring
 * change — the per-user reconciliation invariant and the segregated chart of
 * accounts both have to come out with it.
 */

/** Guard rail: a sweep planner must never be pointed at user-owned addresses. */
export class SegregatedCustodyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegregatedCustodyViolation';
  }
}

export interface SweepCandidate {
  readonly addressId: string;
  readonly address: string;
  /** The wallet the address belongs to. Addresses hang off wallets, not users. */
  readonly walletId: string;
  readonly asset: string;
  readonly balance: string;
  readonly plan: SweepPlan;
}

export interface SweepDeps {
  readonly db: PrismaClient;
  readonly reader: ChainReader;
  readonly chain: string;
  readonly assets: AssetRegistry;
  readonly logger: Logger;
  /** Below this, sweeping costs more in fees than it consolidates. */
  readonly threshold: string;
  /** Held back so the address can still pay for its next transaction. */
  readonly feeReserve: string;
  readonly batchSize: number;
}

export interface SweepService {
  /** Which addresses are worth sweeping right now, and for how much. */
  plan(): Promise<SweepCandidate[]>;
  /** The ledger posting for a completed sweep's fee. */
  feePosting(sweepId: string, asset: string, fee: string): ReturnType<typeof postSweepFee>;
}

export function createSweepService(_deps: SweepDeps): SweepService {
  return {
    async plan(): Promise<SweepCandidate[]> {
      /*
       * Refused, not empty.
       *
       * An empty plan would let a future caller wire this up, see "nothing to
       * sweep", and conclude it works. Sweeping user addresses is a custody
       * violation under ADR-0020, and the failure should be loud enough that
       * nobody re-enables it by accident.
       *
       * The planning ARITHMETIC is retained where it is reusable and safe:
       * `planNativeSweep` in `packages/solana` (never sweep the rent-exempt
       * minimum) and `postSweepFee` in `packages/ledger` (a transfer between
       * two addresses of one owner posts only its fee). House-tier rebalancing
       * (ADR-0018) has exactly that shape and will want both.
       */
      await Promise.resolve();
      throw new SegregatedCustodyViolation(
        'Sweeping user deposit addresses would commingle segregated funds (ADR-0020). ' +
          'House-tier rebalancing is not implemented.',
      );
    },

    feePosting(sweepId, asset, fee) {
      /*
       * The fee, and nothing else.
       *
       * A transfer entry would have to debit and credit the same
       * `chain_assets` account, which is not an entry. Where the money sits is
       * an operational fact recorded on the address rows; it is not an
       * accounting fact.
       */
      return postSweepFee({ sweepId, asset, amount: toAmount(fee) });
    },
  };
}
