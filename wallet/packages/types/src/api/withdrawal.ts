import { z } from 'zod';
import { baseUnitsSchema } from '../money.js';
import { assetSchema } from './custody.js';
import { WITHDRAWAL_STATUSES } from '../withdrawal-states.js';

export const withdrawalStatusSchema = z.enum(WITHDRAWAL_STATUSES);

export const requestWithdrawalSchema = z.object({
  asset: assetSchema,
  /** Base units as a string. Never a number (prompt_phase3.md rule 154). */
  amount: baseUnitsSchema,
  destination: z.string().min(32).max(64),
  /**
   * Client-supplied, so a resubmission after a network failure is the SAME
   * withdrawal rather than a second one (master-prompt rule 87).
   */
  idempotencyKey: z.string().min(8).max(128),
});
export type RequestWithdrawalRequest = z.infer<typeof requestWithdrawalSchema>;

/**
 * The lifecycle, shown explicitly (master-prompt rules 78-79).
 *
 * Never collapsed into "pending" (rule 156): a user in manual review is owed a
 * different message than one whose broadcast failed.
 */
export const withdrawalSchema = z.object({
  id: z.string(),
  asset: assetSchema,
  decimals: z.number().int().min(0).max(32),
  amount: baseUnitsSchema,
  networkFee: baseUnitsSchema.nullable(),
  destination: z.string(),
  status: withdrawalStatusSchema,
  /** True while the funds are reserved in `user_locked`. */
  fundsLocked: z.boolean(),
  /** Terminal states need no further action from anyone. */
  isTerminal: z.boolean(),
  txSignature: z.string().nullable(),
  /** A safe, generic explanation. Never a risk reason code (rules 81-82, 159). */
  statusDetail: z.string(),
  createdAt: z.string().datetime(),
  settledAt: z.string().datetime().nullable(),
});
export type Withdrawal = z.infer<typeof withdrawalSchema>;

export const withdrawalResponseSchema = z.object({ withdrawal: withdrawalSchema });
export type WithdrawalResponse = z.infer<typeof withdrawalResponseSchema>;

export const listWithdrawalsResponseSchema = z.object({
  withdrawals: z.array(withdrawalSchema),
});
export type ListWithdrawalsResponse = z.infer<typeof listWithdrawalsResponseSchema>;

// ---------------------------------------------------------------------------
// Operator queue (rules 160-162)
// ---------------------------------------------------------------------------

export const reviewItemSchema = z.object({
  withdrawal: withdrawalSchema,
  /** The FULL reason codes. Operator-facing only. */
  riskCodes: z.array(z.string()),
  riskVerdict: z.enum(['approve', 'deny', 'review']),
  userId: z.string(),
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const listReviewQueueResponseSchema = z.object({
  items: z.array(reviewItemSchema),
});
export type ListReviewQueueResponse = z.infer<typeof listReviewQueueResponseSchema>;

export const operatorDecisionSchema = z.object({
  /** Required: an operator decision without a stated reason is not auditable. */
  note: z.string().min(3).max(500),
});
export type OperatorDecisionRequest = z.infer<typeof operatorDecisionSchema>;
