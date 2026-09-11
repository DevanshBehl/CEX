import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

export interface RiskDecisionRecord {
  id: string;
  withdrawalId: string;
  verdict: 'approve' | 'deny' | 'review';
  codes: string[];
  evaluatedRules: string[];
  policyVersion: string;
  createdAt: Date;
}

export interface RecordRiskDecisionInput {
  readonly withdrawalId: string;
  readonly verdict: 'approve' | 'deny' | 'review';
  readonly codes: readonly string[];
  readonly evaluatedRules: readonly string[];
  /** Everything needed to replay the decision (master-prompt rule 153). */
  readonly inputSnapshot: Record<string, unknown>;
  readonly outcomes: readonly unknown[];
  readonly policyVersion: string;
}

export interface RiskDecisionRepository {
  /** Append-only: there is no update, and the database would refuse one. */
  record(input: RecordRiskDecisionInput, tx?: Executor): Promise<string>;
  findByWithdrawal(withdrawalId: string, tx?: Executor): Promise<RiskDecisionRecord | null>;
}

export function createRiskDecisionRepository(db: Executor): RiskDecisionRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async record(input, tx) {
      const id = newId();
      await exec(tx).riskDecision.create({
        data: {
          id,
          withdrawalId: input.withdrawalId,
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

    async findByWithdrawal(withdrawalId, tx) {
      const row = await exec(tx).riskDecision.findUnique({ where: { withdrawalId } });
      return row
        ? {
            id: row.id,
            withdrawalId: row.withdrawalId,
            verdict: row.verdict,
            codes: row.codes,
            evaluatedRules: row.evaluatedRules,
            policyVersion: row.policyVersion,
            createdAt: row.createdAt,
          }
        : null;
    },
  };
}
