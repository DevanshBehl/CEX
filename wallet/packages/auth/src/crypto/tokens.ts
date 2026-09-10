import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes (rule 123). 256 bits of entropy is not guessable in any budget. */
const SESSION_TOKEN_BYTES = 32;

export interface OpaqueToken {
  /** Goes in the cookie and nowhere else. */
  readonly value: string;
  /** Goes in the database and nowhere else (rule 102). */
  readonly hash: Uint8Array;
}

/**
 * Session tokens are random and opaque, not signed structures (rules 121-123).
 *
 * The token is stored only as a SHA-256 hash, so a database dump does not hand
 * an attacker a set of live sessions. SHA-256 rather than argon2 is correct
 * here and wrong for passwords: this input already has 256 bits of entropy, so
 * there is no dictionary to slow down, and session lookup happens on every
 * single request.
 */
export function generateSessionToken(): OpaqueToken {
  const value = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  return { value, hash: hashToken(value) };
}

export function hashToken(token: string): Uint8Array {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Constant-time comparison, for anything an attacker can submit repeatedly. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Opaque, unguessable handle for an in-flight ceremony. */
export function generateCeremonyId(): string {
  return randomBytes(24).toString('base64url');
}
