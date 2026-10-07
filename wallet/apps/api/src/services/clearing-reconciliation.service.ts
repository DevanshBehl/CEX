import type { ChainReader } from '@wallet/blockchain';
import {
  createLedgerRepository,
  createSettlementRepository,
  type PrismaClient,
} from '@wallet/db';
import type { Cluster } from '@wallet/types';
import type { MarketEntry } from './trading/markets.js';

/**
 * Reconciling the clearing tier (ADR-0035).
 *
 * Three checks and one alarm. No single check proves solvency, and each one's
 * blind spot is stated where it is computed, so a clean report is never read
 * as more than it is:
 *
 *   1. RESERVE — ledger `clearing_assets` against the clearing address on-chain.
 *      The only check that compares the books with something outside them.
 *      Blind to WHICH user is short, to mis-attribution, wrong fees, unsettled
 *      fills: none of those moves the total.
 *   2. EQUATION — clearing_assets − Σ user trading liabilities == fee equity.
 *      Blind to a fill never settled (it moves nothing) and to a fee charged to
 *      the wrong party (it still lands in house_trading_fees).
 *   3. HOLDS — resting orders against the engine's book, and each user's
 *      `user_order_locked` against their orders' outstanding holds. Blind to a
 *      correctly held order that settled an earlier fill at the wrong price.
 *
 *   ALARM — any user trading balance below zero. Not a streak: nothing
 *   legitimate produces one, and the database refuses to commit one, so a
 *   reading means that refusal was bypassed.
 */

export type CheckStatus = 'clean' | 'drift' | 'inconclusive';

export interface ClearingFinding {
  /** `reserve`, `equation`, `book` or `order_locks`. */
  readonly check: 'reserve' | 'equation' | 'book' | 'order_locks';
  /** The asset or market the finding is about. Never a user. */
  readonly subject: string;
  readonly status: CheckStatus;
  /** Operator-facing numbers. Read deliberately from the report, never logged. */
  readonly detail: Readonly<Record<string, string>>;
}

export interface ClearingReport {
  readonly runAt: string;
  readonly findings: readonly ClearingFinding[];
  readonly negativeTradingAccounts: number;
}

export interface ClearingReconciliationDeps {
  readonly db: PrismaClient;
  readonly reader: ChainReader;
  readonly cluster: Cluster;
  readonly clearingAddress: string;
  readonly nativeAsset: string;
  /** Native base units the house parks at the clearing address. */
  readonly reserve: bigint;
  readonly markets: readonly MarketEntry[];
  /** The settlement worker's offset consumer name. */
  readonly consumer: string;
}

export function createClearingReconciliationService(deps: ClearingReconciliationDeps) {
  const ledger = createLedgerRepository(deps.db);
  const settlement = createSettlementRepository(deps.db);

  async function reserveAndEquation(): Promise<ClearingFinding[]> {
    const totals = await ledger.getClearingTotals(deps.cluster);
    const findings: ClearingFinding[] = [];
    for (const row of totals) {
      const clearing = BigInt(row.clearingAssets);
      const liabilities = BigInt(row.tradingLiabilities);
      const fees = BigInt(row.houseTradingFees);

      // CHECK 2. The slack is exactly the fee equity, or a posting is wrong.
      const slack = clearing - liabilities;
      findings.push({
        check: 'equation',
        subject: row.asset,
        status: slack === fees ? 'clean' : 'drift',
        detail: {
          clearingAssets: row.clearingAssets,
          tradingLiabilities: row.tradingLiabilities,
          houseTradingFees: row.houseTradingFees,
          unexplained: (slack - fees).toString(),
        },
      });

      // CHECK 1. Expected residual is the configured reserve for the native
      // asset and zero otherwise. In-flight allocations and deallocations make
      // single readings drift legitimately; the worker alerts on a streak.
      let observed: bigint | null;
      try {
        observed = BigInt(await deps.reader.getBalance(deps.clearingAddress, row.asset));
      } catch {
        observed = null;
      }
      const expected = row.asset === deps.nativeAsset ? deps.reserve : 0n;
      const residual = observed === null ? null : observed - clearing;
      findings.push({
        check: 'reserve',
        subject: row.asset,
        // An unreadable chain is not evidence of anything.
        status: residual === null ? 'inconclusive' : residual === expected ? 'clean' : 'drift',
        detail: {
          ledgerClearingAssets: row.clearingAssets,
          observed: observed === null ? 'unreadable' : observed.toString(),
          expectedResidual: expected.toString(),
          residual: residual === null ? 'unknown' : residual.toString(),
        },
      });
    }
    return findings;
  }

  async function book(entry: MarketEntry): Promise<ClearingFinding> {
    const subject = entry.symbol;
    const depth = await entry.engine.depth();
    const offset = await settlement.getOffset(deps.consumer, entry.market.id);
    // Like with like: only when settlement has applied exactly the sequence the
    // book reflects. A book read ahead of settlement shows fills the database
    // has not applied yet — lag, not drift.
    if (!depth || !offset || offset.seq !== depth.seq) {
      return {
        check: 'book',
        subject,
        status: 'inconclusive',
        detail: {
          bookSeq: depth ? depth.seq.toString() : 'unreachable',
          settledSeq: offset ? offset.seq.toString() : 'none',
        },
      };
    }

    const held = await settlement.heldLevels(entry.market.id);
    const key = (side: string, price: bigint) => `${side}:${price.toString()}`;
    const engine = new Map<string, bigint>();
    for (const level of depth.bids) engine.set(key('buy', level.price), level.qty);
    for (const level of depth.asks) engine.set(key('sell', level.price), level.qty);
    const database = new Map(held.map((level) => [key(level.side, level.price), level.qty]));

    let engineOnly = 0; // resting with no hold
    let databaseOnly = 0; // a hold for an order that does not rest
    let differing = 0;
    for (const [level, qty] of engine) {
      const ours = database.get(level);
      if (ours === undefined) engineOnly += 1;
      else if (ours !== qty) differing += 1;
    }
    for (const level of database.keys()) if (!engine.has(level)) databaseOnly += 1;

    return {
      check: 'book',
      subject,
      status: engineOnly + databaseOnly + differing === 0 ? 'clean' : 'drift',
      detail: {
        seq: depth.seq.toString(),
        levelsOnlyInEngine: String(engineOnly),
        levelsOnlyInDatabase: String(databaseOnly),
        levelsDiffering: String(differing),
      },
    };
  }

  return {
    async run(): Promise<ClearingReport> {
      const findings = await reserveAndEquation();
      for (const entry of deps.markets) findings.push(await book(entry));

      const mismatches = await settlement.orderLockMismatches(deps.cluster);
      findings.push({
        check: 'order_locks',
        subject: deps.cluster,
        status: mismatches === 0 ? 'clean' : 'drift',
        detail: { mismatchedAccounts: String(mismatches) },
      });

      return {
        runAt: new Date().toISOString(),
        findings,
        negativeTradingAccounts: await settlement.negativeTradingAccounts(deps.cluster),
      };
    },
  };
}
