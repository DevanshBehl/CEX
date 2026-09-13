import type { ChainReader } from '@wallet/blockchain';
import { createLedgerRepository, type PrismaClient } from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import { IN_FLIGHT_WITHDRAWAL_STATUSES, type Cluster } from '@wallet/types';

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

/**
 * One user's segregated position, compared against their own address
 * (ADR-0020, prompt Task 1.3).
 */
export interface UserReconciliation {
  readonly userId: string;
  readonly asset: string;
  /** What this user's own addresses hold, read from the chain. */
  readonly observed: string;
  /** What the ledger says they hold there. */
  readonly ledger: string;
  /** What the platform owes them. */
  readonly liability: string;
  readonly residual: string;
  /**
   * True when this user's own position does not reconcile.
   *
   * CRITICAL, not informational: under segregation a user's funds are supposed
   * to be identifiable and exclusively theirs. A divergence means either their
   * money is not where the books say, or someone else's is.
   */
  readonly diverged: boolean;
  readonly addressesChecked: number;
}

export interface ReconciliationReport {
  readonly runAt: string;
  readonly assets: readonly AssetReconciliation[];
  readonly healthy: boolean;
  /** Deposit addresses + nonce accounts + custody tiers (rule 141). */
  readonly addressesConsidered: number;
  /** Per-user results. Empty when segregated reconciliation is disabled. */
  readonly users: readonly UserReconciliation[];
  /** Users whose own position does not reconcile. Always a critical alert. */
  readonly divergedUsers: number;
  /** Withdrawals that have left the ledger but not yet settled. */
  readonly withdrawalsInFlight: number;
}

export interface ReconciliationDeps {
  readonly db: PrismaClient;
  readonly reader: ChainReader;
  readonly chain: string;
  /**
   * Which cluster's books to compare (ADR-0021).
   *
   * Separate from `chain` because they answer different questions: `chain`
   * filters the ADDRESS rows, `cluster` filters the LEDGER rows. Reconciling
   * every cluster's totals against one cluster's addresses would report a
   * shortfall the size of every other cluster — which is what this did before
   * the cluster dimension existed.
   */
  readonly cluster: Cluster;
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
      const totals = await ledger.getAssetTotals(deps.cluster);

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

      /*
       * PER-USER RECONCILIATION (ADR-0020).
       *
       * The aggregate check above is necessary and no longer sufficient. Under
       * segregation each user's funds sit at their own address, and a total
       * that reconciles while one user is short and another long is precisely
       * the failure this custody model exists to prevent. Only a per-user
       * comparison sees it.
       *
       * Addresses are grouped by owner first, so one RPC read per address
       * serves whichever users own it — the naive shape is one read per
       * (user, address) pair and repeats work.
       */
      const positions = await ledger.getSegregatedPositions(deps.cluster);

      /*
       * Addresses fetched ONCE for everyone, not once per position.
       *
       * The obvious shape — for each (user, asset) position, query that user's
       * addresses and read each balance — is an N+1 query plus a redundant RPC
       * read for every asset the user holds. At a few hundred users it is slow
       * enough to widen the window in which the aggregate and per-user
       * readings disagree, which shows up as phantom drift rather than as a
       * performance problem.
       */
      const owners = [...new Set(positions.map((position) => position.ownerId))];
      const ownedAddresses = await deps.db.address.findMany({
        where: { chain: deps.chain, status: 'active', wallet: { userId: { in: owners } } },
        select: { address: true, wallet: { select: { userId: true } } },
      });

      const addressesByOwner = new Map<string, string[]>();
      for (const row of ownedAddresses) {
        const list = addressesByOwner.get(row.wallet.userId) ?? [];
        list.push(row.address);
        addressesByOwner.set(row.wallet.userId, list);
      }

      // One balance read per (address, asset), shared across that user's
      // positions. A user holding three assets previously read every address
      // three times.
      const balances = new Map<string, bigint | null>();
      const readBalance = async (address: string, asset: string): Promise<bigint | null> => {
        const key = `${address}:${asset}`;
        const cached = balances.get(key);
        if (cached !== undefined) return cached;

        let value: bigint | null;
        try {
          value = BigInt(await deps.reader.getBalance(address, asset));
        } catch {
          value = null;
        }
        balances.set(key, value);
        return value;
      };

      const users: UserReconciliation[] = [];

      for (const position of positions) {
        const owned = addressesByOwner.get(position.ownerId) ?? [];

        let observed = 0n;
        let checked = 0;
        for (const address of owned) {
          const balance = await readBalance(address, position.asset);
          if (balance === null) continue;
          observed += balance;
          checked += 1;
        }

        const residual = observed - BigInt(position.chainAssets);

        users.push({
          userId: position.ownerId,
          asset: position.asset,
          observed: observed.toString(),
          ledger: position.chainAssets,
          liability: position.liability,
          residual: residual.toString(),
          /*
           * Only when every address was readable, and only when the user
           * actually has one.
           *
           * An RPC failure is an incomplete reading, not evidence that funds
           * are missing — and paging someone at 3am for a timeout destroys the
           * alert's meaning.
           */
          diverged: residual !== 0n && owned.length > 0 && checked === owned.length,
          addressesChecked: checked,
        });
      }

      const divergedUsers = users.filter((user) => user.diverged).length;

      if (divergedUsers > 0) {
        // CRITICAL. A user's own funds are not where the books say they are.
        logSecurityEvent(deps.logger, 'reconciliation.user_diverged', {
          outcome: 'failure',
          count: divergedUsers,
        });
      }

      return {
        runAt: new Date().toISOString(),
        assets,
        healthy: healthy && divergedUsers === 0,
        addressesConsidered: addresses.length,
        withdrawalsInFlight,
        users,
        divergedUsers,
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
