import { Keypair, PublicKey } from '@solana/web3.js';
import { derivePath } from 'ed25519-hd-key';
import type {
  Address,
  AddressDeriver,
  AddressValidator,
  AddressVerdict,
  DerivedAddress,
} from '@wallet/blockchain';
import {
  ADDRESS_MAX_CHARS,
  ADDRESS_MIN_CHARS,
  derivationPathForIndex,
  SOLANA_CHAIN_ID,
} from './constants.js';

/**
 * Address validation for Solana (prompt_phase2.md rules 108-110).
 */
export function createSolanaAddressValidator(): AddressValidator {
  return {
    chain: SOLANA_CHAIN_ID,

    isWellFormed(address: string): AddressVerdict {
      if (address.length < ADDRESS_MIN_CHARS || address.length > ADDRESS_MAX_CHARS) {
        return { ok: false, reason: 'wrong_length' };
      }
      try {
        // The constructor performs the base58 decode and the length check.
        // eslint-disable-next-line no-new
        new PublicKey(address);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'malformed' };
      }
    },

    /**
     * Well-formed AND able to receive funds that can later move.
     *
     * The extra check is `isOnCurve`. A Program Derived Address is a valid
     * 32-byte value that is deliberately NOT a point on the Ed25519 curve,
     * which means no private key exists for it and only its owning program can
     * move funds from it. Sending to a PDA of a program that does not expect
     * the transfer puts the funds beyond anyone's reach.
     *
     * Phase 2 never sends, so this has no caller yet. It lives here because
     * Phase 3 validates withdrawal destinations with it, and the knowledge of
     * what makes a Solana address spendable belongs next to the format.
     */
    isSafeDestination(address: string): AddressVerdict {
      const wellFormed = this.isWellFormed(address);
      if (!wellFormed.ok) return wellFormed;

      const key = new PublicKey(address);
      if (!PublicKey.isOnCurve(key.toBytes())) {
        return { ok: false, reason: 'not_signable' };
      }
      return { ok: true };
    },

    normalize(address: string): Address {
      // Base58 is case-sensitive, so normalization is a round-trip through the
      // decoder rather than a case fold — it strips nothing but confirms the
      // canonical encoding.
      return new PublicKey(address).toBase58();
    },
  };
}

/**
 * Deterministic deposit-address derivation (prompt_phase2.md rules 105-107).
 *
 * NOTE ON WHAT THIS DOES NOT DO: it derives ADDRESSES, which are public. Phase 2
 * never signs, so no private key is stored anywhere (ADR-0005). The keypair
 * exists only inside `derive` long enough to read its public key.
 */
export function createSolanaAddressDeriver(seed: Uint8Array): AddressDeriver {
  if (seed.length < 32) {
    throw new Error('derivation seed must be at least 32 bytes');
  }
  const seedHex = Buffer.from(seed).toString('hex');

  return {
    chain: SOLANA_CHAIN_ID,

    derive(index: number): DerivedAddress {
      const derivationPath = derivationPathForIndex(index);
      const { key } = derivePath(derivationPath, seedHex);
      const keypair = Keypair.fromSeed(key);

      return {
        address: keypair.publicKey.toBase58(),
        derivationIndex: index,
        derivationPath,
      };
    },
  };
}
