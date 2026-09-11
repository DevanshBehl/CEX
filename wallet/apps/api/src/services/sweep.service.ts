import type { ChainReader } from '@wallet/blockchain';
import { createCustodyRepository, type PrismaClient } from '@wallet/db';
import { postSweepFee, toAmount } from '@wallet/ledger';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import { planNativeSweep, type SweepPlan } from '@wallet/solana';
import type { AssetRegistry } from '@wallet/types';

/**
 * Sweeps: consolidating deposit addresses into the hot wallet (ADR-0017).
 *
 * # What a sweep is
 *
 * ADR-0004 gives every user their own deposit address, so money arrives spread
 * across as many addresses as there are users. A sweep consolidates it.
 *
 * # What a sweep is NOT
 *
 * It is not a change in what the platform owes anyone. Both addresses are
 * ours, the chart of accounts has one `chain_assets` account per asset, and
 * the ledger's answer to "how much does the platform control" is identical
 * before and after. The ONLY posting is the network fee, drawn from the
 * prepaid house balance rather than from pooled customer funds.
 *
 * **The invariant: total user liabilities are bit-identical across a sweep.**
 * A sweep that moves a user balance is not a sweep with a bug; it is a
 * different operation wearing the name.
 *
 * # Why this is planning only
 *
 * Executing a sweep means signing with a DEPOSIT key, and deposit keys are a
 * separate, lower-privilege class whose only authority is to pay one hardcoded
 * destination (ADR-0005, ADR-0017 §3). That destination lives in the signing
 * service, not in a request — so this service decides WHAT should be swept and
 * the signing boundary decides WHERE it goes. Putting the destination here
 * would hand back exactly the authority ADR-0005 removed.
 */

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

export function createSweepService(deps: SweepDeps): SweepService {
  const custody = createCustodyRepository(deps.db);

  return {
    async plan() {
      const addresses = await deps.db.address.findMany({
        where: { chain: deps.chain, status: 'active', custodyRole: 'deposit' },
        select: { id: true, address: true, walletId: true },
        take: deps.batchSize,
      });

      // Read once per address, from the chain, at the configured commitment.
      // The LEDGER cannot answer this: it records what the platform controls
      // in aggregate, not what sits at any particular address (ADR-0017).
      const rentExemptMinimum = await deps.reader.getMinimumAccountBalance(
        deps.assets.keys[0] ?? 'SOL',
      );

      const candidates: SweepCandidate[] = [];

      for (const address of addresses) {
        const balance = await deps.reader.getBalance(address.address, 'SOL').catch(() => null);
        if (balance === null) continue;

        const plan = planNativeSweep({
          balance,
          // NEVER swept. A swept-to-zero account ceases to exist, and the next
          // deposit pays to recreate it — so the value this appears to release
          // is spent again immediately, plus a fee (rule 133).
          rentExemptMinimum,
          feeReserve: deps.feeReserve,
          threshold: deps.threshold,
        });

        if (!plan.shouldSweep) continue;

        candidates.push({
          addressId: address.id,
          address: address.address,
          walletId: address.walletId,
          asset: 'SOL',
          balance,
          plan,
        });
      }

      if (candidates.length > 0) {
        logSecurityEvent(deps.logger, 'sweep.started', {
          outcome: 'success',
          count: candidates.length,
        });
      }

      void custody;
      return candidates;
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
