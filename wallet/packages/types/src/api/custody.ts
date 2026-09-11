import { z } from 'zod';
import { baseUnitsSchema } from '../money.js';

/**
 * Phase 2 API contracts.
 *
 * Amounts cross the wire as base-unit STRINGS, never numbers
 * (prompt_phase2.md rules 169-170). A JSON number above 2^53 loses precision
 * in the browser before any code touches it, and formatting is the client's
 * job — it is the side that knows the asset's decimals and the user's locale.
 */

/**
 * A ledger asset key: `SOL`, or a mint address (ADR-0016).
 *
 * 44, not 16. A symbol fits in 16 characters and a base58 mint address does
 * not — at 16 every token request was rejected by validation before it reached
 * the allowlist, which would have made SPL support unreachable from the API
 * while every internal test passed.
 *
 * Deliberately NOT a base58 pattern: the allowlist decides what is creditable
 * (ADR-0016), and duplicating that judgement in a wire schema means two places
 * to change when a chain with different address encoding arrives.
 */
export const assetSchema = z.string().min(1).max(44);
export const chainSchema = z.string().min(1).max(32);

export const balanceSchema = z.object({
  asset: assetSchema,
  /** Display metadata. Never used in arithmetic (rule 64). */
  decimals: z.number().int().min(0).max(32),
  available: baseUnitsSchema,
  locked: baseUnitsSchema,
  total: baseUnitsSchema,
});
export type Balance = z.infer<typeof balanceSchema>;

export const listBalancesResponseSchema = z.object({
  balances: z.array(balanceSchema),
});
export type ListBalancesResponse = z.infer<typeof listBalancesResponseSchema>;

export const depositAddressSchema = z.object({
  id: z.string(),
  chain: chainSchema,
  address: z.string(),
  /** The only asset this address accepts. Stated explicitly (rule 172). */
  asset: assetSchema,
  network: z.string(),
  createdAt: z.string().datetime(),
});
export type DepositAddress = z.infer<typeof depositAddressSchema>;

export const depositAddressResponseSchema = z.object({
  walletId: z.string(),
  address: depositAddressSchema,
});
export type DepositAddressResponse = z.infer<typeof depositAddressResponseSchema>;

export const listAddressesResponseSchema = z.object({
  walletId: z.string(),
  addresses: z.array(depositAddressSchema),
});
export type ListAddressesResponse = z.infer<typeof listAddressesResponseSchema>;

/**
 * Deposit lifecycle, shown honestly (rules 173-174).
 *
 * `confirming` means seen on-chain and not yet creditable. It is NOT a balance
 * the user has — the ledger has not moved.
 */
export const depositStatusSchema = z.enum(['confirming', 'credited', 'ignored']);
export type DepositStatus = z.infer<typeof depositStatusSchema>;

export const depositSchema = z.object({
  id: z.string(),
  asset: assetSchema,
  decimals: z.number().int().min(0).max(32),
  /** Total received on-chain. */
  amount: baseUnitsSchema,
  /**
   * The portion held back as a one-time account minimum, not creditable to the
   * user (rules 157-158). Surfaced so the difference between what arrived and
   * what was credited is visible rather than mysterious.
   */
  rentReserved: baseUnitsSchema,
  creditedAmount: baseUnitsSchema,
  status: depositStatusSchema,
  txSignature: z.string(),
  createdAt: z.string().datetime(),
  creditedAt: z.string().datetime().nullable(),
});
export type Deposit = z.infer<typeof depositSchema>;

export const listDepositsResponseSchema = z.object({
  deposits: z.array(depositSchema),
});
export type ListDepositsResponse = z.infer<typeof listDepositsResponseSchema>;

export const depositResponseSchema = z.object({ deposit: depositSchema });
export type DepositResponse = z.infer<typeof depositResponseSchema>;
