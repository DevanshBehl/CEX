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
  /**
   * What to CALL this asset — `SOL`, `USDC`.
   *
   * Carried for the same reason `balanceSchema` carries it: `asset` is a mint
   * address for a token, and the server holds the only authoritative mapping
   * from a mint to a name. Without it the withdrawal history rendered a
   * 44-character base58 string where a ticker belongs — the exact defect the
   * balances endpoint already had and fixed.
   */
  symbol: z.string(),
  decimals: z.number().int().min(0).max(32),
  amount: baseUnitsSchema,
  networkFee: baseUnitsSchema.nullable(),
  /**
   * The fee's own symbol and decimals — NOT the withdrawn asset's.
   *
   * A validator is paid in SOL whatever is being moved (ADR-0016), so a USDC
   * withdrawal has a fee denominated in lamports at nine decimals while the
   * amount beside it is denominated in USDC at six. Rendering the fee with
   * the withdrawal's own decimals and ticker overstated it by a factor of a
   * thousand and labelled it as the token.
   */
  networkFeeSymbol: z.string(),
  networkFeeDecimals: z.number().int().min(0).max(32),
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
