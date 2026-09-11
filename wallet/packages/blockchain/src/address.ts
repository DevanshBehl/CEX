import type { Address, ChainId } from './chain.js';

/**
 * Address validation (prompt_phase2.md rules 93, 108-110).
 *
 * Two questions that are NOT the same, kept apart deliberately:
 *
 *   isWellFormed  — could this string be an address on this chain
 *   isSafeDestination — should we send funds to it
 *
 * A Solana Program Derived Address is well-formed and cannot sign, so funds
 * sent there may be permanently unrecoverable. Collapsing the two questions
 * into one boolean is how that distinction gets lost.
 *
 * Phase 2 only receives, so only the first question has a caller. The second is
 * declared now because Phase 3 validates withdrawal destinations with it, and
 * it belongs next to the code that knows the address format.
 */
export type AddressRejection =
  | 'malformed'
  | 'wrong_length'
  | 'wrong_network'
  | 'not_signable'
  | 'blocked';

export type AddressVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AddressRejection };

export interface AddressValidator {
  readonly chain: ChainId;
  isWellFormed(address: string): AddressVerdict;
  /** Stricter: well-formed AND safe to send funds to. Phase 3 uses this. */
  isSafeDestination(address: string): AddressVerdict;
  /** Normalizes casing/encoding so two spellings of one address compare equal. */
  normalize(address: string): Address;
}

/**
 * Deterministic address derivation (prompt_phase2.md rules 105-107).
 *
 * The contract is reproducibility: the same seed and index always yield the
 * same address, in this process and in one started five years from now. That is
 * what makes ADR-0004's per-user addresses recoverable without the database.
 */
export interface DerivedAddress {
  readonly address: Address;
  readonly derivationIndex: number;
  /** Recorded so rule 106 is actionable rather than theoretical. */
  readonly derivationPath: string;
}

export interface AddressDeriver {
  readonly chain: ChainId;
  derive(index: number): DerivedAddress;
}
