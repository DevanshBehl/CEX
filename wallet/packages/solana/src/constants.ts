/**
 * Solana-specific constants, confined to this package (prompt_phase2.md rule 101).
 */

export const SOLANA_CHAIN_ID = 'solana';

/** The native asset symbol used as the ledger's asset key. */
export const NATIVE_ASSET = 'SOL';

/** 1 SOL = 10^9 lamports. Display metadata only; never used in arithmetic. */
export const NATIVE_DECIMALS = 9;

/** A base58-encoded Ed25519 public key decodes to exactly 32 bytes. */
export const ADDRESS_BYTE_LENGTH = 32;

/**
 * Base58 encodes 32 bytes into 32–44 characters. The lower bound matters:
 * an address with leading zero bytes encodes shorter, and rejecting those
 * would reject valid addresses.
 */
export const ADDRESS_MIN_CHARS = 32;
export const ADDRESS_MAX_CHARS = 44;

/**
 * Derivation path for deposit addresses (ADR-0004).
 *
 * `m/44'/501'/{index}'/0'` is the SLIP-0044 path for Solana with one account
 * per user index. Recorded on every address so the set is reconstructible from
 * the seed alone (prompt_phase2.md rules 106-107).
 */
export function derivationPathForIndex(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError(`derivation index must be a non-negative integer, got ${index}`);
  }
  return `m/44'/501'/${index}'/0'`;
}
