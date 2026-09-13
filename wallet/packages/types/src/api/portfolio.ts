import { z } from 'zod';
import { clusterSchema } from '../clusters.js';

/**
 * Portfolio valuation contracts (Task 3).
 *
 * # Why every money field is a string
 *
 * The same reason every other amount in this API is: JSON numbers are doubles,
 * and a USD figure that arrives as `1234.5600000000001` is a figure someone
 * screenshots. Values are decimal strings with six places, matching
 * `NUMERIC(18,6)`.
 *
 * # Why percentages are basis points
 *
 * An integer. `12.34%` is `1234`, and the client divides by 100 for display.
 * A float here means an allocation that sums to 99.99999%, which reads as a
 * bug in the ledger to anyone who notices.
 */

/** A decimal USD amount, six places. Signed, because a delta can be negative. */
export const usdSchema = z.string().regex(/^-?\d+\.\d{6}$/);

export const holdingSchema = z.object({
  /** The bare asset — `SOL`, or a mint. The cluster is the request's context. */
  asset: z.string(),
  /** For display. Falls back to the asset itself. */
  symbol: z.string(),
  /** Base units, as a string. Never scaled here. */
  amount: z.string(),
  decimals: z.number().int().min(0).max(30),
  /** Null when no price was known at that instant — NOT zero. */
  valueUsd: usdSchema.nullable(),
});
export type PortfolioHolding = z.infer<typeof holdingSchema>;

export const portfolioPointSchema = z.object({
  at: z.string().datetime(),
  totalUsd: usdSchema,
  /**
   * False when a non-zero holding could not be priced at that instant.
   *
   * Surfaced rather than hidden: a chart that silently drops an unpriced asset
   * shows a fall in someone's net worth that did not happen.
   */
  complete: z.boolean(),
});
export type PortfolioPointDto = z.infer<typeof portfolioPointSchema>;

export const portfolioHistoryResponseSchema = z.object({
  cluster: clusterSchema,
  range: z.enum(['24h', '7d', '30d', 'all']),
  points: z.array(portfolioPointSchema),
  /** True when the account has more history than one valuation may read. */
  truncated: z.boolean(),
});
export type PortfolioHistoryResponse = z.infer<typeof portfolioHistoryResponseSchema>;

export const allocationSchema = holdingSchema.extend({
  /** Share of the priced total, in basis points. */
  shareBps: z.number().int(),
  /** 24h change for this asset, in USD. Null where a price was missing. */
  changeUsd: usdSchema.nullable(),
});
export type PortfolioAllocation = z.infer<typeof allocationSchema>;

export const portfolioSummaryResponseSchema = z.object({
  cluster: clusterSchema,
  totalUsd: usdSchema,
  /** Absolute 24h change. Null when there is nothing to compare against. */
  changeUsd: usdSchema.nullable(),
  /**
   * The same change in basis points, or null.
   *
   * Null does NOT mean zero: a portfolio that went from nothing to something
   * has not risen by any percentage, and `∞%` and `0%` are both lies.
   */
  changeBps: z.number().int().nullable(),
  allocations: z.array(allocationSchema),
  complete: z.boolean(),
  truncated: z.boolean(),
});
export type PortfolioSummaryResponse = z.infer<typeof portfolioSummaryResponseSchema>;
