import type { FastifyRequest } from 'fastify';
import { createRiskDecisionRepository, type PrismaClient, type WithdrawalRecord } from '@wallet/db';
import { AuthorizationDeniedError } from '@wallet/errors';
import {
  holdsLock,
  isTerminal,
  type ListReviewQueueResponse,
  type ListWithdrawalsResponse,
  type Withdrawal,
  type WithdrawalResponse,
  type WithdrawalStatus,
} from '@wallet/types';
import { requireSessionRecord } from '../middleware/guards.js';
import type { WithdrawalService } from '../services/withdrawal.service.js';

export interface WithdrawalControllerDeps {
  readonly db: PrismaClient;
  readonly withdrawals: WithdrawalService;
  readonly decimals: Readonly<Record<string, number>>;
  readonly operatorUserIds: readonly string[];
}

export interface WithdrawalControllers {
  request(request: FastifyRequest): Promise<WithdrawalResponse>;
  get(request: FastifyRequest): Promise<WithdrawalResponse>;
  list(request: FastifyRequest): Promise<ListWithdrawalsResponse>;
  reviewQueue(request: FastifyRequest): Promise<ListReviewQueueResponse>;
  approve(request: FastifyRequest): Promise<WithdrawalResponse>;
  reject(request: FastifyRequest): Promise<WithdrawalResponse>;
}

export function createWithdrawalControllers(deps: WithdrawalControllerDeps): WithdrawalControllers {
  const decisions = createRiskDecisionRepository(deps.db);
  const decimalsFor = (asset: string): number => deps.decimals[asset] ?? 0;

  /**
   * Phase 3 has no operator role model (ADR-0011). The queue is gated by
   * configuration plus a step-up, and a real role model is Phase 4.
   */
  function requireOperator(userId: string): void {
    if (!deps.operatorUserIds.includes(userId)) {
      throw new AuthorizationDeniedError('Not found');
    }
  }

  return {
    async request(request) {
      const { userId } = requireSessionRecord(request);
      const body = request.body as {
        asset: string;
        amount: string;
        destination: string;
        idempotencyKey: string;
      };

      const withdrawal = await deps.withdrawals.request({
        userId,
        asset: body.asset,
        amount: body.amount,
        destination: body.destination,
        idempotencyKey: body.idempotencyKey,
        correlationId: request.correlationId,
      });

      return { withdrawal: toWithdrawal(withdrawal, decimalsFor(withdrawal.asset)) };
    },

    async get(request) {
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      const withdrawal = await deps.withdrawals.get(userId, id);
      return { withdrawal: toWithdrawal(withdrawal, decimalsFor(withdrawal.asset)) };
    },

    async list(request) {
      const { userId } = requireSessionRecord(request);
      const rows = await deps.withdrawals.list(userId, 100);
      return { withdrawals: rows.map((row) => toWithdrawal(row, decimalsFor(row.asset))) };
    },

    async reviewQueue(request) {
      const { userId } = requireSessionRecord(request);
      requireOperator(userId);

      const rows = await deps.withdrawals.listForReview(100);
      const items = await Promise.all(
        rows.map(async (row) => {
          const decision = await decisions.findByWithdrawal(row.id);
          return {
            withdrawal: toWithdrawal(row, decimalsFor(row.asset)),
            // The FULL codes, because an operator resolving a review needs to
            // see what the engine saw rather than re-derive it (rule 79).
            riskCodes: decision?.codes ?? [],
            riskVerdict: decision?.verdict ?? ('review' as const),
            userId: row.userId,
          };
        }),
      );
      return { items };
    },

    async approve(request) {
      const { userId } = requireSessionRecord(request);
      requireOperator(userId);
      const { id } = request.params as { id: string };
      const { note } = request.body as { note: string };

      const withdrawal = await deps.withdrawals.approve({
        withdrawalId: id,
        operatorUserId: userId,
        note,
        correlationId: request.correlationId,
      });
      return { withdrawal: toWithdrawal(withdrawal, decimalsFor(withdrawal.asset)) };
    },

    async reject(request) {
      const { userId } = requireSessionRecord(request);
      requireOperator(userId);
      const { id } = request.params as { id: string };
      const { note } = request.body as { note: string };

      const withdrawal = await deps.withdrawals.reject({
        withdrawalId: id,
        operatorUserId: userId,
        note,
        correlationId: request.correlationId,
      });
      return { withdrawal: toWithdrawal(withdrawal, decimalsFor(withdrawal.asset)) };
    },
  };
}

/**
 * A safe, generic explanation per state (rules 155-159).
 *
 * Never a risk reason code: the user learns a withdrawal was declined, not
 * which limit it hit, because that would let them probe the threshold.
 */
const STATUS_DETAIL: Readonly<Record<WithdrawalStatus, string>> = {
  REQUESTED: 'Received.',
  RISK_EVALUATING: 'Running security checks.',
  MANUAL_REVIEW: 'Awaiting manual review. We will update you shortly.',
  APPROVED: 'Approved. Reserving funds.',
  FUNDS_LOCKED: 'Funds reserved. Preparing the transaction.',
  SIGNING: 'Authorising the transaction.',
  SIGNED: 'Authorised. Submitting to the network.',
  BROADCAST: 'Submitted to the network. Waiting for it to finalize.',
  CONFIRMED: 'Confirmed on-chain. Finalising your balance.',
  SETTLED: 'Complete.',
  SIGN_FAILED: 'Authorisation did not complete. Retrying.',
  BROADCAST_FAILED: 'The network did not accept it. Retrying.',
  EXPIRED: 'The transaction expired before it landed. Retrying with a new one.',
  REJECTED: 'This withdrawal was declined.',
  FAILED: 'This withdrawal could not be completed. Your funds have been returned.',
};

function toWithdrawal(row: WithdrawalRecord, decimals: number): Withdrawal {
  return {
    id: row.id,
    asset: row.asset,
    decimals,
    amount: row.amount,
    networkFee: row.networkFee,
    destination: row.destination,
    status: row.status,
    fundsLocked: holdsLock(row.status),
    isTerminal: isTerminal(row.status),
    txSignature: row.txSignature,
    statusDetail: STATUS_DETAIL[row.status],
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  } as Withdrawal;
}
