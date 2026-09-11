import type { ChainReader } from '@wallet/blockchain';
import { createLedgerRepository, type PrismaClient } from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';

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
}

export interface ReconciliationReport {
  readonly runAt: string;
  readonly assets: readonly AssetReconciliation[];
  readonly healthy: boolean;
}

export interface ReconciliationDeps {
  readonly db: PrismaClient;
  readonly reader: ChainReader;
  readonly chain: string;
  readonly logger: Logger;
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
      const addresses = await deps.db.address.findMany({
        where: { chain: deps.chain, status: 'active' },
        select: { address: true },
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

        assets.push({
          asset: total.asset,
          userLiabilities: total.userLiabilities,
          ledgerChainAssets: total.chainAssets,
          observedChainAssets: observed.toString(),
          houseRent: total.houseRent,
          houseFees: total.houseFees,
          residual: residual.toString(),
          addressesChecked: checked,
          explanation: explain(residual, checked, addresses.length),
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

      return { runAt: new Date().toISOString(), assets, healthy };
    },
  };
}

function explain(residual: bigint, checked: number, total: number): string {
  if (checked < total) {
    return `${total - checked} of ${total} addresses could not be read; the observed total is a lower bound.`;
  }
  if (residual === 0n) return 'Books match the chain exactly.';
  if (residual > 0n) {
    // The expected steady state: money has landed but has not reached
    // finality yet, so it is on-chain and not yet in the books.
    return `The chain holds ${residual} base units more than the ledger. Expected when deposits are detected but not yet finalized (ADR-0006); investigate if it persists across cycles.`;
  }
  // Never expected while Phase 2 cannot send. This means funds left without a
  // ledger entry, or a credit was posted for money that never arrived.
  return `The ledger claims ${-residual} base units more than the chain holds. Phase 2 cannot send funds, so this indicates a credit without a corresponding transfer. Investigate immediately.`;
}
