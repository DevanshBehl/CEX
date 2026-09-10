import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import type { Encryptor } from '../crypto/encryption.js';

/**
 * TOTP via a maintained library, never hand-rolled (rule 42).
 *
 * RFC 6238 looks like fifteen lines of HMAC. The parts that are not obvious —
 * the drift window, constant-time comparison, base32 alphabet handling — are
 * exactly the parts that are wrong in hand-rolled implementations.
 */
export interface TotpService {
  generateSecret(): string;
  buildUri(secret: string, accountName: string): string;
  verify(secret: string, code: string): boolean;
  encryptSecret(secret: string): Uint8Array;
  decryptSecret(payload: Uint8Array): string;
  generateRecoveryCodes(count?: number): { plaintext: string[]; hashes: Uint8Array[] };
  hashRecoveryCode(code: string): Uint8Array;
}

const ISSUER = 'Wallet';
const RECOVERY_CODE_COUNT = 10;
/** Crockford-ish: no I, L, O, U — unambiguous when read off a printed sheet. */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function buildTotp(secret: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

export function createTotpService(encryptor: Encryptor): TotpService {
  return {
    generateSecret() {
      return new Secret({ size: 20 }).base32;
    },

    buildUri(secret, accountName) {
      const totp = buildTotp(secret);
      totp.label = accountName;
      return totp.toString();
    },

    verify(secret, code) {
      // window: 1 accepts the adjacent 30-second steps, covering ordinary
      // clock drift. Wider windows trade real security for the convenience of
      // users whose phone clock is badly wrong.
      const delta = buildTotp(secret).validate({ token: code, window: 1 });
      return delta !== null;
    },

    encryptSecret(secret) {
      return encryptor.encrypt(secret);
    },

    decryptSecret(payload) {
      return encryptor.decrypt(payload);
    },

    /**
     * Recovery codes are shown exactly once and stored only as hashes
     * (rule 133). SHA-256 rather than argon2: these are 80 bits of uniform
     * randomness, not a human-chosen password, so there is no dictionary
     * attack to slow down.
     */
    generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
      const plaintext: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const chars: string[] = [];
        for (let j = 0; j < 16; j += 1) {
          chars.push(RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]!);
          if (j % 4 === 3 && j !== 15) chars.push('-');
        }
        plaintext.push(chars.join(''));
      }
      return { plaintext, hashes: plaintext.map(hashRecoveryCode) };
    },

    hashRecoveryCode,
  };
}

function hashRecoveryCode(code: string): Uint8Array {
  // Normalized so the user can type it lowercase, with or without dashes.
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  return createHash('sha256').update(normalized, 'utf8').digest();
}

/** Exported for tests that need entropy without a full service. */
export function randomBase32Secret(): string {
  return new Secret({ size: 20, buffer: randomBytes(20).buffer as ArrayBuffer }).base32;
}
