import { z } from 'zod';
import type { Brand } from './brands.js';

/**
 * Money as an integer count of an asset's smallest indivisible unit, carried as
 * a decimal string (prompt_phase1.md rules 52-53, master-prompt rule 115).
 *
 * String, not number: 2^53 lamports is ~9 million SOL, and IEEE-754 cannot
 * represent every integer above that. String, not bigint: it has to survive
 * JSON without a custom serializer.
 *
 * Phase 1 defines the type and nothing else. Arithmetic, accounts, and balances
 * are Phase 2 — deliberately, so no monetary field exists before the ledger
 * design that governs it (rule 205).
 */
export type BaseUnits = Brand<string, 'BaseUnits'>;

const BASE_UNITS_PATTERN = /^-?(0|[1-9]\d*)$/;

export const baseUnitsSchema = z
  .string()
  .regex(BASE_UNITS_PATTERN, 'must be an integer string in an asset base unit')
  .transform((v): BaseUnits => v as BaseUnits);

/** Throws on malformed input. Use at trust boundaries only. */
export function asBaseUnits(value: string): BaseUnits {
  if (!BASE_UNITS_PATTERN.test(value)) {
    throw new TypeError(`not a base-unit integer string: ${value}`);
  }
  return value as BaseUnits;
}
