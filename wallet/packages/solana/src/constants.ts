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

/**
 * Genesis hashes, which identify a Solana cluster unambiguously.
 *
 * Used to verify that `SOLANA_RPC_URL` actually serves `SOLANA_NETWORK`.
 * Hostname matching cannot do this: a custom RPC provider has an arbitrary
 * hostname, and the whole point is to catch a URL that does not look like what
 * it serves.
 *
 * `localnet` is absent on purpose — a fresh `solana-test-validator` generates a
 * new genesis hash on every reset, so there is no constant to check against.
 */
export const GENESIS_HASHES: Readonly<Record<string, string>> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};
