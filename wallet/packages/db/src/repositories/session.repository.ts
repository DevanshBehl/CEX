import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';
import type { SessionRecord } from './types.js';

export interface CreateSessionInput {
  userId: string;
  tokenHash: Uint8Array;
  expiresAt: Date;
  ip?: string | undefined;
  userAgent?: string | undefined;
  stepUpAt?: Date | undefined;
}

export interface SessionRepository {
  create(input: CreateSessionInput, tx?: Executor): Promise<SessionRecord>;
  findLiveByTokenHash(
    tokenHash: Uint8Array,
    now: Date,
    tx?: Executor,
  ): Promise<SessionRecord | null>;
  touch(id: string, lastSeenAt: Date, tx?: Executor): Promise<void>;
  stampStepUp(id: string, at: Date, tx?: Executor): Promise<void>;
  listLiveByUser(userId: string, now: Date, tx?: Executor): Promise<SessionRecord[]>;
  revoke(id: string, userId: string, tx?: Executor): Promise<boolean>;
  revokeAllForUser(userId: string, exceptId?: string, tx?: Executor): Promise<number>;
  deleteExpiredBefore(cutoff: Date, tx?: Executor): Promise<number>;
}

export function createSessionRepository(db: Executor): SessionRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async create(input, tx) {
      return exec(tx).session.create({
        data: {
          id: newId(),
          userId: input.userId,
          tokenHash: Buffer.from(input.tokenHash),
          expiresAt: input.expiresAt,
          ...(input.ip !== undefined ? { ip: input.ip } : {}),
          ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
          ...(input.stepUpAt !== undefined ? { stepUpAt: input.stepUpAt } : {}),
        },
      });
    },

    /**
     * "Live" means all three of: not revoked, not past its absolute expiry, and
     * looked up by hash rather than by the raw token (rule 102). The idle
     * timeout is applied by the caller against lastSeenAt, because expiring a
     * session and reporting why are different concerns.
     */
    async findLiveByTokenHash(tokenHash, now, tx) {
      const row = await exec(tx).session.findUnique({
        where: { tokenHash: Buffer.from(tokenHash) },
      });
      if (!row) return null;
      if (row.revokedAt !== null) return null;
      if (row.expiresAt <= now) return null;
      return row;
    },

    async touch(id, lastSeenAt, tx) {
      await exec(tx).session.update({ where: { id }, data: { lastSeenAt } });
    },

    async stampStepUp(id, at, tx) {
      await exec(tx).session.update({ where: { id }, data: { stepUpAt: at } });
    },

    async listLiveByUser(userId, now, tx) {
      return exec(tx).session.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { lastSeenAt: 'desc' },
      });
    },

    async revoke(id, userId, tx) {
      const result = await exec(tx).session.updateMany({
        where: { id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count === 1;
    },

    /** Used on every credential change (rule 128). */
    async revokeAllForUser(userId, exceptId, tx) {
      const result = await exec(tx).session.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(exceptId !== undefined ? { id: { not: exceptId } } : {}),
        },
        data: { revokedAt: new Date() },
      });
      return result.count;
    },

    async deleteExpiredBefore(cutoff, tx) {
      const result = await exec(tx).session.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      });
      return result.count;
    },
  };
}
