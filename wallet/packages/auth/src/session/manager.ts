import type { PrismaClient, SessionRecord, SessionRepository } from '@wallet/db';
import { SessionExpiredError, StepUpRequiredError } from '@wallet/errors';
import { generateSessionToken, hashToken } from '../crypto/tokens.js';

export interface SessionPolicy {
  readonly idleTtlSeconds: number;
  readonly absoluteTtlSeconds: number;
  readonly stepUpMaxAgeSeconds: number;
}

export interface IssuedSession {
  readonly session: SessionRecord;
  /** The only time the raw token exists outside the cookie. Hand it straight
   *  to the cookie writer and never log or persist it (rule 102). */
  readonly token: string;
}

export interface SessionContext {
  readonly session: SessionRecord;
  readonly userId: string;
}

export interface SessionManager {
  issue(input: {
    userId: string;
    ip?: string | undefined;
    userAgent?: string | undefined;
    steppedUp?: boolean;
  }): Promise<IssuedSession>;

  /** Resolves a raw cookie value to a live session, applying the idle timeout
   *  and refreshing lastSeenAt. Returns null when there is no valid session. */
  resolve(token: string, now?: Date): Promise<SessionContext | null>;

  /** Issues a new token for the same user and revokes the old session
   *  (rule 126). Used on every privilege change. */
  rotate(current: SessionRecord, options?: { steppedUp?: boolean }): Promise<IssuedSession>;

  revoke(sessionId: string, userId: string): Promise<boolean>;
  revokeAllOthers(userId: string, keepSessionId: string): Promise<number>;
  list(userId: string): Promise<SessionRecord[]>;

  stampStepUp(sessionId: string): Promise<Date>;
  /** Throws StepUpRequiredError when the session has not stepped up recently
   *  enough (rules 135-137). */
  requireStepUp(session: SessionRecord, maxAgeSeconds?: number, now?: Date): void;
}

export function createSessionManager(
  sessions: SessionRepository,
  policy: SessionPolicy,
  _client?: PrismaClient,
): SessionManager {
  async function mint(
    userId: string,
    options: { ip?: string | undefined; userAgent?: string | undefined; steppedUp?: boolean },
  ): Promise<IssuedSession> {
    const { value, hash } = generateSessionToken();
    const session = await sessions.create({
      userId,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + policy.absoluteTtlSeconds * 1000),
      ip: options.ip,
      userAgent: options.userAgent,
      ...(options.steppedUp === true ? { stepUpAt: new Date() } : {}),
    });
    return { session, token: value };
  }

  return {
    async issue(input) {
      return mint(input.userId, {
        ip: input.ip,
        userAgent: input.userAgent,
        ...(input.steppedUp !== undefined ? { steppedUp: input.steppedUp } : {}),
      });
    },

    async resolve(token, now = new Date()) {
      // Lookup is by hash, so a token never has to be compared as a string
      // and the raw value never reaches a query log.
      const session = await sessions.findLiveByTokenHash(hashToken(token), now);
      if (!session) return null;

      // Two clocks, both required (rule 125). The absolute expiry is checked
      // by the repository; the idle timeout is applied here so that an
      // abandoned session on a shared machine closes itself.
      const idleDeadline = new Date(session.lastSeenAt.getTime() + policy.idleTtlSeconds * 1000);
      if (idleDeadline <= now) {
        await sessions.revoke(session.id, session.userId);
        return null;
      }

      // Written on every request. For Phase 1's traffic this is fine; if it
      // ever becomes a write-amplification problem, the fix is to skip the
      // update when lastSeenAt is younger than some fraction of the idle TTL.
      await sessions.touch(session.id, now);

      return { session: { ...session, lastSeenAt: now }, userId: session.userId };
    },

    async rotate(current, options = {}) {
      const issued = await mint(current.userId, {
        ip: current.ip ?? undefined,
        userAgent: current.userAgent ?? undefined,
        ...(options.steppedUp !== undefined ? { steppedUp: options.steppedUp } : {}),
      });
      await sessions.revoke(current.id, current.userId);
      return issued;
    },

    async revoke(sessionId, userId) {
      return sessions.revoke(sessionId, userId);
    },

    async revokeAllOthers(userId, keepSessionId) {
      return sessions.revokeAllForUser(userId, keepSessionId);
    },

    async list(userId) {
      return sessions.listLiveByUser(userId, new Date());
    },

    async stampStepUp(sessionId) {
      const at = new Date();
      await sessions.stampStepUp(sessionId, at);
      return at;
    },

    requireStepUp(session, maxAgeSeconds = policy.stepUpMaxAgeSeconds, now = new Date()) {
      if (session.revokedAt !== null) throw new SessionExpiredError();
      if (session.stepUpAt === null) throw new StepUpRequiredError(maxAgeSeconds);

      const ageSeconds = (now.getTime() - session.stepUpAt.getTime()) / 1000;
      if (ageSeconds > maxAgeSeconds) throw new StepUpRequiredError(maxAgeSeconds);
    },
  };
}
