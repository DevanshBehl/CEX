import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord, SessionRepository } from '@wallet/db';
import { SessionExpiredError, StepUpRequiredError } from '@wallet/errors';
import { createSessionManager, type SessionPolicy } from './manager.js';
import { hashToken } from '../crypto/tokens.js';

/**
 * A fake repository rather than a mocking framework: the behaviour under test
 * is the manager's policy logic, and a hand-written fake makes the state it
 * operates on visible in the test file.
 */
function createFakeSessionRepository(): SessionRepository & { rows: Map<string, SessionRecord> } {
  const rows = new Map<string, SessionRecord>();
  const byHash = new Map<string, string>();
  let seq = 0;

  const key = (h: Uint8Array): string => Buffer.from(h).toString('hex');

  return {
    rows,
    async create(input) {
      const id = `session-${(seq += 1)}`;
      const now = new Date();
      const row: SessionRecord = {
        id,
        userId: input.userId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: input.expiresAt,
        revokedAt: null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        stepUpAt: input.stepUpAt ?? null,
      };
      rows.set(id, row);
      byHash.set(key(input.tokenHash), id);
      return row;
    },
    async findLiveByTokenHash(tokenHash, now) {
      const id = byHash.get(key(tokenHash));
      const row = id !== undefined ? rows.get(id) : undefined;
      if (!row || row.revokedAt !== null || row.expiresAt <= now) return null;
      return row;
    },
    async touch(id, lastSeenAt) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, lastSeenAt });
    },
    async stampStepUp(id, at) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, stepUpAt: at });
    },
    async listLiveByUser(userId, now) {
      return [...rows.values()].filter(
        (r) => r.userId === userId && r.revokedAt === null && r.expiresAt > now,
      );
    },
    async revoke(id, userId) {
      const row = rows.get(id);
      if (!row || row.userId !== userId || row.revokedAt !== null) return false;
      rows.set(id, { ...row, revokedAt: new Date() });
      return true;
    },
    async revokeAllForUser(userId, exceptId) {
      let count = 0;
      for (const [id, row] of rows) {
        if (row.userId !== userId || row.revokedAt !== null || id === exceptId) continue;
        rows.set(id, { ...row, revokedAt: new Date() });
        count += 1;
      }
      return count;
    },
    async deleteExpiredBefore(cutoff) {
      let count = 0;
      for (const [id, row] of rows) {
        if (row.expiresAt < cutoff) {
          rows.delete(id);
          count += 1;
        }
      }
      return count;
    },
  };
}

const POLICY: SessionPolicy = {
  idleTtlSeconds: 1800,
  absoluteTtlSeconds: 86_400,
  stepUpMaxAgeSeconds: 300,
};

let repo: ReturnType<typeof createFakeSessionRepository>;
let manager: ReturnType<typeof createSessionManager>;

beforeEach(() => {
  repo = createFakeSessionRepository();
  manager = createSessionManager(repo, POLICY);
});

describe('issuing and resolving', () => {
  it('returns the raw token exactly once and stores only its hash (rule 102)', async () => {
    const { token, session } = await manager.issue({ userId: 'u1' });
    expect(token).toBeTruthy();
    // The stored row carries no field that could reconstruct the token.
    expect(JSON.stringify(session)).not.toContain(token);
    const resolved = await manager.resolve(token);
    expect(resolved?.userId).toBe('u1');
  });

  it('rejects a token that was never issued', async () => {
    expect(await manager.resolve('made-up-token')).toBeNull();
  });

  it('rejects a revoked session immediately (rule 127)', async () => {
    const { token, session } = await manager.issue({ userId: 'u1' });
    expect(await manager.revoke(session.id, 'u1')).toBe(true);
    expect(await manager.resolve(token)).toBeNull();
  });

  it("will not let one user revoke another's session", async () => {
    const { token, session } = await manager.issue({ userId: 'alice' });
    expect(await manager.revoke(session.id, 'mallory')).toBe(false);
    expect(await manager.resolve(token)).not.toBeNull();
  });
});

describe('expiry (rule 125)', () => {
  it('enforces the absolute lifetime', async () => {
    const { token } = await manager.issue({ userId: 'u1' });
    const afterAbsolute = new Date(Date.now() + (POLICY.absoluteTtlSeconds + 1) * 1000);
    expect(await manager.resolve(token, afterAbsolute)).toBeNull();
  });

  it('enforces the idle timeout independently of the absolute lifetime', async () => {
    const { token } = await manager.issue({ userId: 'u1' });
    // Well inside the absolute window, well outside the idle one.
    const afterIdle = new Date(Date.now() + (POLICY.idleTtlSeconds + 1) * 1000);
    expect(await manager.resolve(token, afterIdle)).toBeNull();
  });

  it('revokes an idled-out session rather than leaving it resolvable later', async () => {
    const { token, session } = await manager.issue({ userId: 'u1' });
    await manager.resolve(token, new Date(Date.now() + (POLICY.idleTtlSeconds + 1) * 1000));
    expect(repo.rows.get(session.id)?.revokedAt).not.toBeNull();
    expect(await manager.resolve(token)).toBeNull();
  });

  it('keeps a session alive while it is being used', async () => {
    const { token } = await manager.issue({ userId: 'u1' });
    let at = Date.now();
    for (let i = 0; i < 5; i += 1) {
      at += (POLICY.idleTtlSeconds - 60) * 1000;
      expect(await manager.resolve(token, new Date(at))).not.toBeNull();
    }
  });
});

describe('rotation (rule 126)', () => {
  it('issues a new token and kills the old one', async () => {
    const first = await manager.issue({ userId: 'u1' });
    const second = await manager.rotate(first.session);

    expect(second.token).not.toBe(first.token);
    expect(await manager.resolve(first.token)).toBeNull();
    expect(await manager.resolve(second.token)).not.toBeNull();
  });

  it('can mark the rotated session as freshly stepped up', async () => {
    const first = await manager.issue({ userId: 'u1' });
    const second = await manager.rotate(first.session, { steppedUp: true });
    expect(second.session.stepUpAt).not.toBeNull();
    expect(() => manager.requireStepUp(second.session)).not.toThrow();
  });

  it('carries the client attribution forward', async () => {
    const first = await manager.issue({ userId: 'u1', ip: '203.0.113.7', userAgent: 'UA/1' });
    const second = await manager.rotate(first.session);
    expect(second.session.ip).toBe('203.0.113.7');
    expect(second.session.userAgent).toBe('UA/1');
  });
});

describe('revoke all others (rule 128)', () => {
  it('leaves only the current session alive', async () => {
    const keep = await manager.issue({ userId: 'u1' });
    const others = await Promise.all([
      manager.issue({ userId: 'u1' }),
      manager.issue({ userId: 'u1' }),
    ]);
    const untouched = await manager.issue({ userId: 'u2' });

    expect(await manager.revokeAllOthers('u1', keep.session.id)).toBe(2);
    expect(await manager.resolve(keep.token)).not.toBeNull();
    for (const other of others) expect(await manager.resolve(other.token)).toBeNull();
    // Another user's sessions are untouched.
    expect(await manager.resolve(untouched.token)).not.toBeNull();
  });
});

describe('step-up (rules 135-139)', () => {
  it('refuses a session that has never stepped up', async () => {
    const { session } = await manager.issue({ userId: 'u1' });
    expect(() => manager.requireStepUp(session)).toThrow(StepUpRequiredError);
  });

  it('accepts a recent step-up', async () => {
    const { session } = await manager.issue({ userId: 'u1' });
    const at = await manager.stampStepUp(session.id);
    expect(() => manager.requireStepUp({ ...session, stepUpAt: at })).not.toThrow();
  });

  it('expires a step-up after the configured age', async () => {
    const { session } = await manager.issue({ userId: 'u1' });
    const at = await manager.stampStepUp(session.id);
    const later = new Date(at.getTime() + (POLICY.stepUpMaxAgeSeconds + 1) * 1000);
    expect(() => manager.requireStepUp({ ...session, stepUpAt: at }, undefined, later)).toThrow(
      StepUpRequiredError,
    );
  });

  it('lets a caller demand a stricter freshness than the default', async () => {
    const { session } = await manager.issue({ userId: 'u1' });
    const at = await manager.stampStepUp(session.id);
    const later = new Date(at.getTime() + 60_000);
    // Fine under the 300s default...
    expect(() => manager.requireStepUp({ ...session, stepUpAt: at }, 300, later)).not.toThrow();
    // ...but not for an operation that demands 30s. Phase 3 uses this for
    // high-value withdrawals.
    expect(() => manager.requireStepUp({ ...session, stepUpAt: at }, 30, later)).toThrow(
      StepUpRequiredError,
    );
  });

  it('reports the required age so the client can prompt (rule 137)', async () => {
    const { session } = await manager.issue({ userId: 'u1' });
    try {
      manager.requireStepUp(session, 120);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StepUpRequiredError);
      expect((error as StepUpRequiredError).maxAgeSeconds).toBe(120);
    }
  });

  it('treats a revoked session as expired, not as merely needing step-up', async () => {
    const { session } = await manager.issue({ userId: 'u1' });
    expect(() =>
      manager.requireStepUp({ ...session, revokedAt: new Date(), stepUpAt: new Date() }),
    ).toThrow(SessionExpiredError);
  });
});

describe('token hashing', () => {
  it('is deterministic and collision-free across many tokens', async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { token } = await manager.issue({ userId: 'u1' });
      hashes.add(Buffer.from(hashToken(token)).toString('hex'));
    }
    expect(hashes.size).toBe(200);
  });
});
