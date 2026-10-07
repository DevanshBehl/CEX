import { logSecurityEvent, runWithContext, type Logger } from '@wallet/logger';
import { randomUUID } from 'node:crypto';
import type { ClearingReport } from '../services/clearing-reconciliation.service.js';
import type { ReconciliationReport } from '../services/reconciliation.service.js';
import type { WalletMetrics } from '../observability/metrics.js';

/**
 * Reconciliation on a schedule (master-prompt rule 172, prompt_phase4.md
 * rules 140, 144).
 *
 * WHY DRIFT MUST PERSIST BEFORE IT ALERTS
 *
 * A single non-zero residual is the NORMAL steady state, not an incident. A
 * deposit that has landed on-chain but has not reached finality is money the
 * chain can see and the ledger deliberately cannot (ADR-0006) — so at any
 * moment when someone is depositing, the residual is positive and correct.
 *
 * Alerting on one reading therefore produces an alert on every busy minute,
 * and an alert that fires constantly is an alert nobody reads. What actually
 * indicates a problem is drift that is STILL THERE on the next cycle, and the
 * one after: a residual that does not resolve is not timing.
 *
 * The exception is a negative residual with nothing in flight (rule 148),
 * which the service escalates immediately and which no amount of waiting makes
 * more legitimate.
 */

export interface ReconciliationWorkerDeps {
  readonly run: () => Promise<ReconciliationReport>;
  readonly logger: Logger;
  /** How many consecutive drifting cycles before it is an alert. */
  readonly consecutiveCyclesBeforeAlert: number;
  readonly metrics?: WalletMetrics;
  readonly intervalMs: number;
  /** Injectable for tests; defaults to the real timer. */
  readonly setTimer?: typeof setInterval;
  readonly clearTimer?: typeof clearInterval;
}

export interface ReconciliationWorker {
  runOnce(): Promise<ReconciliationReport>;
  start(): void;
  stop(): void;
  /**
   * Consecutive drifting cycles per asset — or per `check:subject` for the
   * clearing tier. Exposed for tests and operators.
   */
  streak(asset: string): number;
}

export function createReconciliationWorker(deps: ReconciliationWorkerDeps): ReconciliationWorker {
  const streaks = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * The clearing tier (ADR-0035): the same streak rule, one counter per
   * (check, subject). An INCONCLUSIVE reading — an unreadable chain, a book
   * read ahead of settlement — neither extends nor resets a streak: it is a
   * reading that did not happen, not evidence either way.
   */
  function clearing(report: ClearingReport): void {
    for (const finding of report.findings) {
      const key = `${finding.check}:${finding.subject}`;
      deps.metrics?.reconciliationCheck.set(
        finding.status === 'clean' ? 1 : finding.status === 'drift' ? 0 : -1,
        { check: finding.check, subject: finding.subject },
      );
      if (finding.status === 'inconclusive') continue;
      const streak = finding.status === 'drift' ? (streaks.get(key) ?? 0) + 1 : 0;
      if (streak > 0) streaks.set(key, streak);
      else streaks.delete(key);
      if (streak === deps.consecutiveCyclesBeforeAlert) {
        logSecurityEvent(
          deps.logger,
          finding.check === 'book' || finding.check === 'order_locks'
            ? 'reconciliation.book_mismatch_persisted'
            : 'reconciliation.clearing_drift_persisted',
          {
            outcome: 'failure',
            count: streak,
            targetType: finding.check,
            targetId: finding.subject,
          },
        );
      }
    }

    // NOT a streak (rule 97). Nothing legitimate produces a negative trading
    // balance and the database refuses to commit one, so the first reading is
    // already proof — of a bypassed or broken constraint.
    if (report.negativeTradingAccounts > 0) {
      logSecurityEvent(deps.logger, 'reconciliation.negative_trading_balance', {
        outcome: 'failure',
        count: report.negativeTradingAccounts,
      });
    }
  }

  return {
    async runOnce() {
      const correlationId = randomUUID();
      return runWithContext({ correlationId, route: 'worker:reconciliation' }, async () => {
        const report = await deps.run();

        for (const asset of report.assets) {
          const drifting = asset.residual !== '0';
          const streak = drifting ? (streaks.get(asset.asset) ?? 0) + 1 : 0;

          if (drifting) streaks.set(asset.asset, streak);
          else streaks.delete(asset.asset);

          // Exactly at the threshold, not above it: alerting on every
          // subsequent cycle turns one problem into a pager storm.
          if (streak === deps.consecutiveCyclesBeforeAlert) {
            logSecurityEvent(deps.logger, 'reconciliation.drift_persisted', {
              outcome: 'failure',
              count: streak,
              // The asset key is a closed set; the AMOUNT is not logged. It is
              // in the report, which an operator reads deliberately.
              targetType: 'asset',
              targetId: asset.asset,
            });
          }
        }

        if (report.clearing) clearing(report.clearing);
        return report;
      });
    },

    start() {
      if (timer !== undefined) return;
      const schedule = deps.setTimer ?? setInterval;
      timer = schedule(() => {
        void this.runOnce().catch(() => {
          // A failed cycle is not a drift signal — it is a cycle that did not
          // happen, and treating it as "no drift" would reset the streak and
          // hide a real problem behind an unrelated outage.
          deps.logger.error('reconciliation cycle failed', { errorName: 'ReconciliationError' });
        });
      }, deps.intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer === undefined) return;
      (deps.clearTimer ?? clearInterval)(timer);
      timer = undefined;
    },

    streak(asset) {
      return streaks.get(asset) ?? 0;
    },
  };
}
