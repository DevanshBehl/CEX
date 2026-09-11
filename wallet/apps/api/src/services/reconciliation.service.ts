import type { ChainReader } from '@wallet/blockchain';
import { createLedgerRepository, type PrismaClient } from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import { IN_FLIGHT_WITHDRAWAL_STATUSES } from '@wallet/types';

export interface AssetReconciliation {
  readonly asset: string;
  /** What the platform owes users, from the ledger. */
  readonly userLiabilities: string;
  /** What the ledger says the platform controls on-chain. */
  readonly ledgerChainAssets: string;
  /** What the chain actually says. */
  readonly observedChainAssets: string;
  readonly houseRent: string;
  readonly houseFees: string;
  /**
   * observed - ledger. Non-zero is not automatically an error, but it must be
   * explainable (prompt_phase2.md rule 163).
   */
  readonly residual: string;
  readonly addressesChecked: number;
  readonly explanation: string;
  /**
   * True when the residual is negative AND nothing is in flight (rule 148).
   *
   * A negative residual means the ledger claims more than the chain holds.
   * While a withdrawal is mid-flight that is ordinary: the funds have left but
   * settlement has not posted. With nothing in flight it is not ordinary at
   * all — it means a credit exists for money that never arrived, or money left
   * without an entry. Those are the two worst things the books can say.
   */
  readonly unexplainedShortfall: boolean;
}

export interface ReconciliationReport {
  readonly runAt: string;
  readonly assets: readonly AssetReconciliation[];
  readonly healthy: boolean;
  /** Deposit addresses + nonce accounts + custody tiers (rule 141). */
  readonly addressesConsidered: number;
  /** Withdrawals that have left the ledger but not yet settled. */
  readonly withdrawalsInFlight: number;
}

export interface ReconciliationDeps {
  readonly db: PrismaClient;
  readonly reader: ChainReader;
  readonly chain: string;
  readonly logger: Logger;
  /**
   * Platform addresses that are not user deposit addresses: the treasury and
   * each custody tier (rule 141, ADR-0018).
   *
   * Phase 3 left these outside the comparison, which made every residual
   * approximate by exactly the treasury balance — and an approximate
   * reconciliation cannot distinguish "fine" from "slightly wrong".
   */
  readonly platformAddresses?: readonly string[];
}

/**
 * Reconciliation (master-prompt rule 120, prompt_phase2.md rules 161-166).
 *
 * This is the only check in the system that compares the books against
 * something outside them. The ledger's own invariants prove internal
 * consistency and cannot detect a deposit that was never credited, or funds
 * that left without an entry — for that, someone has to ask the chain.
 *
 * It reads from ledger ENTRIES, never from a cache or a derived value
 * (rule 165). A reconciliation that trusts a cached balance is reconciling the
 * cache against the chain and would report zero drift while the entries said
 * something else entirely.
 */
export function createReconciliationService(deps: ReconciliationDeps) {
  const ledger = createLedgerRepository(deps.db);

  return {
    async run(): Promise<ReconciliationReport> {
      const totals = await ledger.getAssetTotals();

      /**
       * EVERY platform-owned address (rule 141).
       *
       * Three sources, because the platform's funds live in three places:
       * user deposit addresses, the durable nonce accounts (each holding a
       * rent-exempt minimum that is real money), and the treasury or custody
       * tiers. Omitting the nonce accounts was the Phase 3 gap — five accounts
       * times the rent minimum is a small, permanent, unexplainable residual,
       * and a permanently non-zero residual trains operators to ignore the
       * report.
       */
      const [depositAddresses, nonceAccounts] = await Promise.all([
        deps.db.address.findMany({
          where: { chain: deps.chain, status: 'active' },
          select: { address: true },
        }),
        deps.db.nonceAccount.findMany({
          where: { chain: deps.chain, status: { not: 'retired' } },
          select: { address: true },
        }),
      ]);

      const addresses = [
        ...depositAddresses,
        ...nonceAccounts,
        ...(deps.platformAddresses ?? []).map((address) => ({ address })),
      ].filter(
        // A treasury that is also a configured tier would otherwise be counted
        // twice, which reads as a surplus exactly the size of the hot wallet.
        (entry, index, all) => all.findIndex((e) => e.address === entry.address) === index,
      );

      const withdrawalsInFlight = await deps.db.withdrawal.count({
        where: { status: { in: [...IN_FLIGHT_WITHDRAWAL_STATUSES] } },
      });

      const assets: AssetReconciliation[] = [];

      for (const total of totals) {
        let observed = 0n;
        let checked = 0;

        for (const { address } of addresses) {
          try {
            observed += BigInt(await deps.reader.getBalance(address, total.asset));
            checked += 1;
          } catch {
            // An address that cannot be read makes the total a lower bound
            // rather than a fact. `addressesChecked` is what tells the reader
            // that, which is why a partial run is still worth reporting.
          }
        }

        const ledgerAssets = BigInt(total.chainAssets);
        const residual = observed - ledgerAssets;
        const unexplainedShortfall = residual < 0n && withdrawalsInFlight === 0;

        assets.push({
          asset: total.asset,
          userLiabilities: total.userLiabilities,
          ledgerChainAssets: total.chainAssets,
          observedChainAssets: observed.toString(),
          houseRent: total.houseRent,
          houseFees: total.houseFees,
          residual: residual.toString(),
          addressesChecked: checked,
          explanation: explain(residual, checked, addresses.length, withdrawalsInFlight),
          unexplainedShortfall,
        });
      }

      const healthy = assets.every(
        (a) => a.residual === '0' && a.addressesChecked === addresses.length,
      );

      logSecurityEvent(
        deps.logger,
        healthy ? 'reconciliation.completed' : 'reconciliation.drift_detected',
        { outcome: healthy ? 'success' : 'failure', count: assets.length },
      );

      // Rule 148. Escalated separately from ordinary drift because it is a
      // different severity: ordinary drift is usually timing, this is not.
      const shortfalls = assets.filter((a) => a.unexplainedShortfall);
      if (shortfalls.length > 0) {
        logSecurityEvent(deps.logger, 'reconciliation.negative_residual', {
          outcome: 'failure',
          count: shortfalls.length,
        });
      }

      return {
        runAt: new Date().toISOString(),
        assets,
        healthy,
        addressesConsidered: addresses.length,
        withdrawalsInFlight,
      };
    },
  };
}

function explain(
  residual: bigint,
  checked: number,
  total: number,
  withdrawalsInFlight: number,
): string {
  if (checked < total) {
    return `${total - checked} of ${total} addresses could not be read; the observed total is a lower bound.`;
  }
  if (residual === 0n) return 'Books match the chain exactly.';
  if (residual > 0n) {
    // The expected steady state: money has landed but has not reached
    // finality yet, so it is on-chain and not yet in the books.
    return `The chain holds ${residual} base units more than the ledger. Expected when deposits are detected but not yet finalized (ADR-0006); investigate if it persists across cycles.`;
  }
  if (withdrawalsInFlight > 0) {
    // Ordinary: the funds have left the chain but settlement has not posted.
    return `The ledger claims ${-residual} base units more than the chain holds, with ${withdrawalsInFlight} withdrawal(s) in flight. Expected while a broadcast transaction has not settled; investigate if it persists after they finish.`;
  }
  // The worst thing the books can say (rule 148).
  return `The ledger claims ${-residual} base units more than the chain holds, and NOTHING is in flight. A credit exists for money that never arrived, or funds left without an entry. Investigate immediately.`;
}
