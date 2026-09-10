import type { Redis } from 'ioredis';
import { generateCeremonyId } from '../crypto/tokens.js';

export type CeremonyKind = 'registration' | 'authentication' | 'stepup';

export interface CeremonyRecord {
  readonly kind: CeremonyKind;
  /** base64url, as issued in the WebAuthn options. */
  readonly challenge: string;
  /** Present when the ceremony is bound to a known user up front. */
  readonly userId?: string;
  /** Registration only — the pending account, before it exists. */
  readonly pendingEmail?: string;
  readonly pendingDisplayName?: string;
}

export interface ChallengeStore {
  put(record: CeremonyRecord): Promise<string>;
  /** Atomically fetches AND removes. A second call for the same id returns
   *  null — that is what makes a challenge single-use (rule 104). */
  consume(ceremonyId: string): Promise<CeremonyRecord | null>;
}

const KEY_PREFIX = 'webauthn:ceremony:';

/**
 * Redis rather than a table (rule 103 permits either).
 *
 * Two properties decide it:
 *   - TTL is free, so an abandoned ceremony expires on its own instead of
 *     accumulating rows nobody ever cleans up.
 *   - GETDEL is atomic, so single-use needs no transaction and no
 *     read-then-delete window for two concurrent verifies to race through.
 *
 * Losing Redis loses in-flight ceremonies, which is harmless: the browser
 * simply starts a new one. Nothing durable lives here.
 */
export function createRedisChallengeStore(redis: Redis, ttlSeconds: number): ChallengeStore {
  return {
    async put(record) {
      const ceremonyId = generateCeremonyId();
      await redis.set(KEY_PREFIX + ceremonyId, JSON.stringify(record), 'EX', ttlSeconds);
      return ceremonyId;
    },

    async consume(ceremonyId) {
      const raw = await redis.getdel(KEY_PREFIX + ceremonyId);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as CeremonyRecord;
      } catch {
        return null;
      }
    },
  };
}

/** In-memory equivalent for unit tests. Same single-use semantics. */
export function createInMemoryChallengeStore(ttlMs = 120_000): ChallengeStore {
  const entries = new Map<string, { record: CeremonyRecord; expiresAt: number }>();

  return {
    async put(record) {
      const ceremonyId = generateCeremonyId();
      entries.set(ceremonyId, { record, expiresAt: Date.now() + ttlMs });
      return ceremonyId;
    },

    async consume(ceremonyId) {
      const entry = entries.get(ceremonyId);
      entries.delete(ceremonyId);
      if (!entry || entry.expiresAt < Date.now()) return null;
      return entry.record;
    },
  };
}
