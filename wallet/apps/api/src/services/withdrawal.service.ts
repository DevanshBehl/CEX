import type { AddressValidator } from '@wallet/blockchain';
import {
  createLedgerRepository,
  createRiskDecisionRepository,
  createWithdrawalRepository,
  withTransaction,
  type PrismaClient,
  type WithdrawalRecord,
} from '@wallet/db';
import {
  AuthorizationDeniedError,
  InsufficientFundsError,
  PolicyDeniedError,
} from '@wallet/errors';
import { postWithdrawalLock, postWithdrawalRelease, toAmount, toBaseUnits } from '@wallet/ledger';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import {
  evaluate,
  toClientMessage,
  type RiskInput,
  type RiskPolicy,
  type DestinationCheck,
} from '@wallet/risk';
import type { WithdrawalStatus } from '@wallet/types';
import type { WithdrawalValuation } from './withdrawal-valuation.js';

export interface WithdrawalServiceDeps {
  readonly db: PrismaClient;
  readonly validator: AddressValidator;
  readonly policy: RiskPolicy;
  readonly chain: string;
  readonly logger: Logger;
  /** Injected so risk evaluation stays testable at a window boundary. */
  readonly clock?: () => Date;
  /**
   * Prices a withdrawal for value-based review (ADR-0024). Without it the
   * engine is told nothing about value, which a USD-threshold policy reviews.
   */
  readonly valuation?: WithdrawalValuation;
}

export interface RequestWithdrawalInput {
  readonly userId: string;
  readonly asset: string;
  readonly amount: string;
  readonly destination: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface WithdrawalService {
  request(input: RequestWithdrawalInput): Promise<WithdrawalRecord>;
  get(userId: string, withdrawalId: string): Promise<WithdrawalRecord>;
  list(userId: string, limit: number): Promise<WithdrawalRecord[]>;
  listForReview(limit: number): Promise<WithdrawalRecord[]>;
  approve(input: {
    withdrawalId: string;
    operatorUserId: string;
    note: string;
    correlationId: string;
  }): Promise<WithdrawalRecord>;
  reject(input: {
    withdrawalId: string;
    operatorUserId: string;
    note: string;
    correlationId: string;
  }): Promise<WithdrawalRecord>;
}

export function createWithdrawalService(deps: WithdrawalServiceDeps): WithdrawalService {
  const withdrawals = createWithdrawalRepository(deps.db);
  const decisions = createRiskDecisionRepository(deps.db);
  const ledger = createLedgerRepository(deps.db);
  const now = deps.clock ?? (() => new Date());

  /**
   * Reserve the funds (master-prompt rule 118, prompt_phase3.md rules 109-114).
   *
   * The lock and the state transition are ONE database transaction, so they can
   * never disagree — a locked withdrawal that is not `FUNDS_LOCKED`, or the
   * reverse, is not a state this system can reach.
   *
   * This is also the sufficient-funds check. It is not in the risk engine
   * because the check and the reservation have to be the same atomic act: two
   * concurrent withdrawals can each pass a balance check and both proceed,
   * whereas only one can win the ledger write.
   */
  async function lockFunds(
    withdrawal: WithdrawalRecord,
    correlationId: string,
  ): Promise<WithdrawalRecord> {
    const amount = toAmount(withdrawal.amount);

    // Ledger accounts are created BEFORE the serializable transaction — the
    // Phase 2 lesson (rules 61-62). `user_locked` will not exist for most users
    // until their first withdrawal, so this is exactly the contended case.
    await ledger.ensureAccounts([
      { ownerId: withdrawal.userId, asset: withdrawal.asset, type: 'user_available' },
      { ownerId: withdrawal.userId, asset: withdrawal.asset, type: 'user_locked' },
    ]);

    return withTransaction(deps.db, async (tx) => {
      const balance = await createLedgerRepository(tx).getUserBalance(
        withdrawal.userId,
        withdrawal.asset,
        tx,
      );

      if (BigInt(balance.available) < amount) {
        // Read inside the same serializable transaction that would post the
        // lock, so a concurrent withdrawal cannot slip between the two.
        throw new InsufficientFundsError();
      }

      const posting = postWithdrawalLock({
        withdrawalId: withdrawal.id,
        userId: withdrawal.userId,
        asset: withdrawal.asset,
        amount,
      });

      const ledgerTransactionId = await createLedgerRepository(tx).postTransaction(
        {
          kind: posting.kind,
          referenceType: posting.referenceType,
          referenceId: posting.referenceId,
          entries: posting.entries.map((entry) => ({
            account: {
              ownerId: entry.account.ownerId,
              asset: entry.account.asset,
              type: entry.account.type,
            },
            asset: entry.asset,
            amount: toBaseUnits(entry.amount),
            direction: entry.direction,
          })),
        },
        tx,
      );

      const locked = await createWithdrawalRepository(tx).transition(
        {
          withdrawalId: withdrawal.id,
          from: 'APPROVED',
          to: 'FUNDS_LOCKED',
          reason: 'funds reserved',
          correlationId,
          patch: { lockLedgerTransactionId: ledgerTransactionId },
        },
        tx,
      );

      if (!locked) throw new Error(`withdrawal ${withdrawal.id} was not APPROVED when locking`);
      return locked;
    });
  }

  async function buildRiskInput(input: RequestWithdrawalInput): Promise<RiskInput> {
    const at = now();
    const user = await deps.db.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { status: true },
    });

    const windowStart = new Date(at.getTime() - 24 * 60 * 60 * 1000);
    const recent = await withdrawals.listRecentForUser(input.userId, windowStart);
    const priorSince = new Date(
      at.getTime() - deps.policy.knownDestinationWindowDays * 24 * 60 * 60 * 1000,
    );
    const priorDestinations = await withdrawals.listPriorDestinations(input.userId, priorSince);

    // The engine is chain-free, so it receives the adapter's verdict rather
    // than decoding an address itself.
    const verdict = deps.validator.isSafeDestination(input.destination);
    const owned = await deps.db.address.findFirst({
      where: { chain: deps.chain, address: input.destination },
      select: { id: true },
    });

    // Priced here, before the engine, because the engine reads no database.
    // A pricing failure is an unknown value, never an exception that blocks
    // the request: unknown values are reviewed.
    const amount = toAmount(input.amount);
    const valueUsdMicros =
      deps.valuation === undefined
        ? undefined
        : await deps.valuation(input.asset, amount, at).catch(() => null);

    const destinationCheck: DestinationCheck = verdict.ok
      ? { ok: true, isPlatformOwned: owned !== null }
      : { ok: false, reason: verdict.reason === 'not_signable' ? 'not_signable' : 'invalid' };

    return {
      userId: input.userId,
      accountStatus: user.status,
      asset: input.asset,
      amount,
      destination: input.destination,
      destinationCheck,
      ...(valueUsdMicros !== undefined ? { valueUsdMicros } : {}),
      priorDestinations,
      recentWithdrawals: recent.map((w) => ({
        amount: toAmount(w.amount),
        asset: w.asset,
        createdAt: w.createdAt,
      })),
      now: at,
    };
  }

  return {
    /**
     * Submit a withdrawal: record, evaluate, and either lock, queue for review,
     * or reject (master-prompt rules 131-137).
     */
    async request(input) {
      const created = await withdrawals.create({
        userId: input.userId,
        chain: deps.chain,
        asset: input.asset,
        amount: input.amount,
        destination: input.destination,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      });

      // Idempotency: the same key is the SAME withdrawal, returned as it
      // stands. It is not re-evaluated and not re-locked (rules 147-148).
      if (created.outcome === 'existing') {
        return created.withdrawal;
      }

      const withdrawal = created.withdrawal;

      const evaluating = await withdrawals.transition({
        withdrawalId: withdrawal.id,
        from: 'REQUESTED',
        to: 'RISK_EVALUATING',
        correlationId: input.correlationId,
      });
      if (!evaluating) return withdrawal;

      const riskInput = await buildRiskInput(input);
      const decision = evaluate(riskInput, deps.policy);

      // Persisted with its inputs, so it can be replayed and explain itself
      // years later (master-prompt rule 153).
      await decisions.record({
        withdrawalId: withdrawal.id,
        verdict: decision.verdict,
        codes: decision.codes,
        evaluatedRules: decision.evaluatedRules,
        inputSnapshot: {
          accountStatus: riskInput.accountStatus,
          asset: riskInput.asset,
          amount: riskInput.amount.toString(),
          destinationCheck: riskInput.destinationCheck,
          priorDestinationCount: riskInput.priorDestinations.length,
          recentWithdrawalCount: riskInput.recentWithdrawals.length,
          valueUsdMicros:
            riskInput.valueUsdMicros === undefined || riskInput.valueUsdMicros === null
              ? null
              : riskInput.valueUsdMicros.toString(),
          trailingTotal: riskInput.recentWithdrawals
            .reduce((total, w) => total + w.amount, 0n)
            .toString(),
          now: riskInput.now.toISOString(),
        },
        outcomes: decision.outcomes.map((outcome) => ({ ...outcome })),
        policyVersion: decision.policyVersion,
      });

      logSecurityEvent(deps.logger, `withdrawal.risk_${decision.verdict}`, {
        outcome: decision.verdict === 'deny' ? 'failure' : 'success',
        userId: input.userId,
        targetType: 'withdrawal',
        targetId: withdrawal.id,
        reason: decision.codes.join(','),
      });

      if (decision.verdict === 'deny') {
        await withdrawals.transition({
          withdrawalId: withdrawal.id,
          from: 'RISK_EVALUATING',
          to: 'REJECTED',
          reason: decision.codes.join(','),
          correlationId: input.correlationId,
        });
        // The client gets a generic message; the codes stay in the decision
        // record and the operator queue (rules 81-82).
        throw new PolicyDeniedError(decision.codes, toClientMessage(decision.codes));
      }

      if (decision.verdict === 'review') {
        const queued = await withdrawals.transition({
          withdrawalId: withdrawal.id,
          from: 'RISK_EVALUATING',
          to: 'MANUAL_REVIEW',
          reason: decision.codes.join(','),
          correlationId: input.correlationId,
        });
        return queued ?? withdrawal;
      }

      const approved = await withdrawals.transition({
        withdrawalId: withdrawal.id,
        from: 'RISK_EVALUATING',
        to: 'APPROVED',
        reason: 'auto-approved',
        correlationId: input.correlationId,
      });
      if (!approved) return withdrawal;

      try {
        return await lockFunds(approved, input.correlationId);
      } catch (error) {
        // The lock is the sufficient-funds check, so a failure here rejects the
        // withdrawal rather than leaving it approved and unfunded.
        await withdrawals.transition({
          withdrawalId: withdrawal.id,
          from: 'APPROVED',
          to: 'REJECTED',
          reason: error instanceof InsufficientFundsError ? 'INSUFFICIENT_FUNDS' : 'lock_failed',
          correlationId: input.correlationId,
        });
        throw error;
      }
    },

    async get(userId, withdrawalId) {
      const withdrawal = await withdrawals.findById(withdrawalId);
      // Another user's withdrawal is not found, never forbidden — a 403 would
      // confirm the id exists. A withdrawal on another cluster is the same:
      // from this context it does not exist.
      if (!withdrawal || withdrawal.userId !== userId || withdrawal.chain !== deps.chain) {
        throw new AuthorizationDeniedError('Withdrawal not found');
      }
      return withdrawal;
    },

    async list(userId, limit) {
      // This service belongs to one cluster, so its history does too.
      return withdrawals.listForUser(userId, limit, deps.chain);
    },

    async listForReview(limit) {
      // This service belongs to one cluster, so its review queue does too: an
      // operator approving on devnet must not be shown a mainnet withdrawal.
      return withdrawals.listByStatus('MANUAL_REVIEW' as WithdrawalStatus, limit, deps.chain);
    },

    /** An operator approves a reviewed withdrawal, which then locks funds. */
    async approve(input) {
      const approved = await withdrawals.transition({
        withdrawalId: input.withdrawalId,
        from: 'MANUAL_REVIEW',
        to: 'APPROVED',
        reason: input.note,
        actorUserId: input.operatorUserId,
        correlationId: input.correlationId,
      });
      if (!approved) throw new AuthorizationDeniedError('Withdrawal is not awaiting review');

      logSecurityEvent(deps.logger, 'withdrawal.operator_approved', {
        outcome: 'success',
        userId: input.operatorUserId,
        targetType: 'withdrawal',
        targetId: input.withdrawalId,
      });

      try {
        return await lockFunds(approved, input.correlationId);
      } catch (error) {
        await withdrawals.transition({
          withdrawalId: input.withdrawalId,
          from: 'APPROVED',
          to: 'REJECTED',
          reason: error instanceof InsufficientFundsError ? 'INSUFFICIENT_FUNDS' : 'lock_failed',
          correlationId: input.correlationId,
        });
        throw error;
      }
    },

    async reject(input) {
      const rejected = await withdrawals.transition({
        withdrawalId: input.withdrawalId,
        from: 'MANUAL_REVIEW',
        to: 'REJECTED',
        reason: input.note,
        actorUserId: input.operatorUserId,
        correlationId: input.correlationId,
      });
      if (!rejected) throw new AuthorizationDeniedError('Withdrawal is not awaiting review');

      logSecurityEvent(deps.logger, 'withdrawal.operator_rejected', {
        outcome: 'success',
        userId: input.operatorUserId,
        targetType: 'withdrawal',
        targetId: input.withdrawalId,
      });

      return rejected;
    },
  };
}

/** Release a lock back to the user (master-prompt rule 119). */
export async function releaseLock(db: PrismaClient, withdrawal: WithdrawalRecord): Promise<string> {
  const posting = postWithdrawalRelease({
    withdrawalId: withdrawal.id,
    userId: withdrawal.userId,
    asset: withdrawal.asset,
    amount: toAmount(withdrawal.amount),
  });

  return withTransaction(db, async (tx) =>
    createLedgerRepository(tx).postTransaction(
      {
        kind: posting.kind,
        referenceType: posting.referenceType,
        referenceId: posting.referenceId,
        entries: posting.entries.map((entry) => ({
          account: {
            ownerId: entry.account.ownerId,
            asset: entry.account.asset,
            type: entry.account.type,
          },
          asset: entry.asset,
          amount: toBaseUnits(entry.amount),
          direction: entry.direction,
        })),
      },
      tx,
    ),
  );
}
