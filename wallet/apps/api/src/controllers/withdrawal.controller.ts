import type { FastifyRequest } from 'fastify';
import { createRiskDecisionRepository, type PrismaClient, type WithdrawalRecord } from '@wallet/db';
import { NotFoundError } from '@wallet/errors';
import {
  holdsLock,
  isTerminal,
  type ListReviewQueueResponse,
  type ListWithdrawalsResponse,
  type Withdrawal,
  type WithdrawalResponse,
  type WithdrawalStatus,
} from '@wallet/types';
import {
  ledgerAssetKey,
  parseLedgerAssetKey,
  type AssetRegistry,
  type Cluster,
} from '@wallet/types';
import { requireSessionRecord } from '../middleware/guards.js';
import type { WithdrawalService } from '../services/withdrawal.service.js';
import { createOperatorRepository, type OperatorRoleName } from '@wallet/db';

export interface WithdrawalControllerDeps {
  readonly db: PrismaClient;
  /**
   * The per-cluster object graph for a request (ADR-0021).
   *
   * The asset arriving on a withdrawal request is a BARE symbol or mint — the
   * client says `SOL`, not `devnet:SOL` — and the cluster comes from the
   * request's context. Qualifying it here, at the boundary, is what keeps the
   * wire free of a storage detail while making it impossible for an
   * unqualified key to reach the ledger.
   */
  readonly runtimeFor: (cluster: Cluster) => {
    readonly withdrawals: WithdrawalService;
    readonly assets: AssetRegistry;
  };
  /**
   * Bootstrap operators, from configuration.
   *
   * Retained ONLY so an environment with no granted roles yet is still
   * administrable — someone has to be able to make the first grant. Every
   * other operator comes from `operator_roles`, and this list should be empty
   * in any environment that has run its bootstrap (rule 166).
   */
  readonly bootstrapOperatorUserIds: readonly string[];
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

  /** Storage speaks cluster-qualified keys; the wire speaks bare assets. */
  const wireAsset = (assetKey: string): string => {
    try {
      return parseLedgerAssetKey(assetKey).asset;
    } catch {
      return assetKey;
    }
  };

  const operators = createOperatorRepository(deps.db);

  /**
   * Operator authority, from granted roles (rule 166).
   *
   * Phase 3 gated this on a configured list of user ids. That made authority a
   * deploy-time property: granting needed a restart, revoking needed a
   * restart, and nothing recorded who granted it or why — all three worst
   * during an incident, which is when operator authority is used.
   *
   * NOT FOUND, never FORBIDDEN — as a 404 STATUS, not merely a 404-sounding
   * message. The previous implementation threw `AuthorizationDeniedError`
   * with the body text "Not found", which reads correctly and returns 403:
   * the status still confirms the route exists and that this account simply
   * lacks the role, which is the disclosure the message was trying to avoid.
   */
  async function requireRole(userId: string, required: OperatorRoleName): Promise<void> {
    if (deps.bootstrapOperatorUserIds.includes(userId)) return;

    const held = await operators.rolesFor(userId);

    // `custodian` implies `approver` implies `viewer`. The hierarchy is here
    // rather than in the database so a grant records exactly what was given,
    // not what it happens to imply today — if the implication changes, old
    // grants still mean what they said.
    const implied: Record<OperatorRoleName, readonly OperatorRoleName[]> = {
      viewer: ['viewer', 'approver', 'custodian'],
      approver: ['approver', 'custodian'],
      custodian: ['custodian'],
    };

    if (!held.some((role) => implied[required].includes(role))) {
      throw new NotFoundError();
    }
  }

  /** Reading the queue needs only `viewer`. */
  const requireOperator = (userId: string): Promise<void> => requireRole(userId, 'viewer');

  /** Deciding a withdrawal moves money, and needs `approver`. */
  const requireApprover = (userId: string): Promise<void> => requireRole(userId, 'approver');

  return {
    async request(request) {
      const { userId } = requireSessionRecord(request);
      const body = request.body as {
        asset: string;
        amount: string;
        destination: string;
        idempotencyKey: string;
      };

      const runtime = deps.runtimeFor(request.cluster);
      const withdrawal = await runtime.withdrawals.request({
        userId,
        // The cluster comes from the request's context, never from the body: a
        // client that could name the cluster in the payload could ask for a
        // mainnet withdrawal while the interface showed devnet.
        asset: ledgerAssetKey(request.cluster, body.asset),
        amount: body.amount,
        destination: body.destination,
        idempotencyKey: body.idempotencyKey,
        correlationId: request.correlationId,
      });

      return { withdrawal: render(runtime, withdrawal) };
    },

    async get(request) {
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      const runtime = deps.runtimeFor(request.cluster);
      const withdrawal = await runtime.withdrawals.get(userId, id);
      return { withdrawal: render(runtime, withdrawal) };
    },

    async list(request) {
      const { userId } = requireSessionRecord(request);
      const runtime = deps.runtimeFor(request.cluster);
      const rows = await runtime.withdrawals.list(userId, 100);
      return { withdrawals: rows.map((row) => render(runtime, row)) };
    },

    async reviewQueue(request) {
      const { userId } = requireSessionRecord(request);
      // Reading the queue is `viewer`: it exposes other users' withdrawals,
      // so it is privileged, but it moves nothing.
      await requireOperator(userId);

      const runtime = deps.runtimeFor(request.cluster);
      const rows = await runtime.withdrawals.listForReview(100);
      const items = await Promise.all(
        rows.map(async (row) => {
          const decision = await decisions.findByWithdrawal(row.id);
          return {
            withdrawal: render(runtime, row),
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
      // Approving releases funds. `approver`, not `viewer`.
      await requireApprover(userId);
      const { id } = request.params as { id: string };
      const { note } = request.body as { note: string };

      const runtime = deps.runtimeFor(request.cluster);
      const withdrawal = await runtime.withdrawals.approve({
        withdrawalId: id,
        operatorUserId: userId,
        note,
        correlationId: request.correlationId,
      });
      return { withdrawal: render(runtime, withdrawal) };
    },

    async reject(request) {
      const { userId } = requireSessionRecord(request);
      // Rejecting returns funds to the user, which is also a money decision.
      await requireApprover(userId);
      const { id } = request.params as { id: string };
      const { note } = request.body as { note: string };

      const runtime = deps.runtimeFor(request.cluster);
      const withdrawal = await runtime.withdrawals.reject({
        withdrawalId: id,
        operatorUserId: userId,
        note,
        correlationId: request.correlationId,
      });
      return { withdrawal: render(runtime, withdrawal) };
    },
  };

  function render(runtime: { readonly assets: AssetRegistry }, row: WithdrawalRecord): Withdrawal {
    const { assets } = runtime;
    return toWithdrawal(row, {
      asset: wireAsset(row.asset),
      symbol: assets.symbolOf(row.asset),
      decimals: assets.decimalsOf(row.asset),
      // The fee is the NATIVE asset's, whatever was withdrawn (ADR-0016).
      feeSymbol: assets.symbolOf(assets.nativeKey),
      feeDecimals: assets.decimalsOf(assets.nativeKey),
    });
  }
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

interface AssetDisplay {
  readonly asset: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly feeSymbol: string;
  readonly feeDecimals: number;
}

function toWithdrawal(row: WithdrawalRecord, display: AssetDisplay): Withdrawal {
  return {
    id: row.id,
    asset: display.asset,
    symbol: display.symbol,
    decimals: display.decimals,
    amount: row.amount,
    networkFee: row.networkFee,
    networkFeeSymbol: display.feeSymbol,
    networkFeeDecimals: display.feeDecimals,
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
