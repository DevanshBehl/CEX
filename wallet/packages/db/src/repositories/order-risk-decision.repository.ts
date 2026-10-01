import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

/** Append-only persistence for pre-trade risk decisions (ADR-0033). */
export interface RecordOrderRiskDecisionInput {
  readonly userId: string;
  readonly clientOrderId: string;
  readonly market: string;
  readonly verdict: 'approve' | 'deny' | 'review';
  readonly codes: readonly string[];
  readonly evaluatedRules: readonly string[];
  readonly inputSnapshot: Record<string, unknown>;
  readonly outcomes: readonly Record<string, unknown>[];
  readonly policyVersion: string;
}

export interface OrderRiskDecisionRepository {
  record(input: RecordOrderRiskDecisionInput, tx?: Executor): Promise<string>;
  countForUser(userId: string, tx?: Executor): Promise<number>;
}

export function createOrderRiskDecisionRepository(db: Executor): OrderRiskDecisionRepository {
  const exec = (tx?: Executor) => tx ?? db;
  return {
    async record(input, tx) {
      const id = newId();
      await exec(tx).orderRiskDecision.create({
        data: {
          id,
          userId: input.userId,
          clientOrderId: input.clientOrderId,
          market: input.market,
          verdict: input.verdict,
          codes: [...input.codes],
          evaluatedRules: [...input.evaluatedRules],
          inputSnapshot: input.inputSnapshot as never,
          outcomes: input.outcomes as never,
          policyVersion: input.policyVersion,
        },
      });
      return id;
    },
    async countForUser(userId, tx) {
      return exec(tx).orderRiskDecision.count({ where: { userId } });
    },
  };
}
