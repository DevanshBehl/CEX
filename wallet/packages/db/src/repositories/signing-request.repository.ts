import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

export interface SigningRequestRepository {
  /**
   * Record that a signature was ASKED FOR (master-prompt rule 110).
   *
   * NEVER records key material, a share, or the signature itself. It records
   * that a request was made, by whom, under what authorization, and what came
   * back — which is what an auditor needs and is all they may have
   * (prompt_phase3.md rules 129-130).
   */
  open(
    input: {
      withdrawalId: string;
      requestId: string;
      keyRef: string;
      signerKind: string;
      authorization: Record<string, unknown>;
    },
    tx?: Executor,
  ): Promise<string>;
  succeed(requestId: string, tx?: Executor): Promise<void>;
  fail(requestId: string, reason: string, tx?: Executor): Promise<void>;
  /**
   * Fail whatever is still open for a withdrawal.
   *
   * The request id includes the nonce, which may not exist yet when signing
   * fails early — so the withdrawal is the reliable handle at that point.
   */
  failForWithdrawal(withdrawalId: string, reason: string, tx?: Executor): Promise<void>;
  findByRequestId(
    requestId: string,
    tx?: Executor,
  ): Promise<{ id: string; outcome: string } | null>;
  countForWithdrawal(withdrawalId: string, tx?: Executor): Promise<number>;
}

export function createSigningRequestRepository(db: Executor): SigningRequestRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async open(input, tx) {
      const id = newId();
      await exec(tx).signingRequest.create({
        data: {
          id,
          withdrawalId: input.withdrawalId,
          requestId: input.requestId,
          keyRef: input.keyRef,
          signerKind: input.signerKind,
          authorization: input.authorization as never,
        },
      });
      return id;
    },

    async succeed(requestId, tx) {
      await exec(tx).signingRequest.updateMany({
        where: { requestId },
        data: { outcome: 'succeeded', completedAt: new Date() },
      });
    },

    async fail(requestId, reason, tx) {
      await exec(tx).signingRequest.updateMany({
        where: { requestId },
        data: { outcome: 'failed', failureReason: reason, completedAt: new Date() },
      });
    },

    async failForWithdrawal(withdrawalId, reason, tx) {
      await exec(tx).signingRequest.updateMany({
        where: { withdrawalId, outcome: 'requested' },
        data: { outcome: 'failed', failureReason: reason, completedAt: new Date() },
      });
    },

    async findByRequestId(requestId, tx) {
      const row = await exec(tx).signingRequest.findUnique({
        where: { requestId },
        select: { id: true, outcome: true },
      });
      return row;
    },

    async countForWithdrawal(withdrawalId, tx) {
      return exec(tx).signingRequest.count({ where: { withdrawalId } });
    },
  };
}
