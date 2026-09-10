import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAuditLogRepository,
  createCredentialRepository,
  createPrismaClient,
  createRecoveryCodeRepository,
  createSessionRepository,
  createUserRepository,
  newId,
  withTransaction,
  type PrismaClient,
} from './index.js';

/**
 * Integration tests against a real PostgreSQL (prompt_phase1.md rule 190).
 *
 * A mock or SQLite would pass while proving nothing: the guarantees under test
 * here — role grants, an append-only trigger, transaction rollback, unique
 * constraints — are properties of Postgres, not of the repository code.
 *
 * Requires `pnpm infra:up`. The APP url is deliberately used: these tests
 * assert what the APPLICATION role can and cannot do.
 */
const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.MIGRATION_DATABASE_URL;

let db: PrismaClient;
let owner: PrismaClient;
const createdUserIds: string[] = [];

beforeAll(async () => {
  if (!APP_URL || !OWNER_URL) {
    throw new Error(
      'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run with `pnpm test:integration` after `pnpm infra:up`.',
    );
  }
  db = createPrismaClient({ url: APP_URL });
  owner = createPrismaClient({ url: OWNER_URL });
  await db.$connect();
});

afterAll(async () => {
  // audit_log rows cannot be deleted by design, so tests use unique event
  // names rather than cleaning up after themselves.
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await db.$disconnect();
  await owner.$disconnect();
});

async function makeUser(): Promise<string> {
  const users = createUserRepository(db);
  const user = await users.create({ email: `${newId()}@example.test`, displayName: 'Test' });
  createdUserIds.push(user.id);
  return user.id;
}

// ---------------------------------------------------------------------------

describe('audit_log is append-only (rules 106-108, 181)', () => {
  it('permits INSERT', async () => {
    const audit = createAuditLogRepository(db);
    await expect(
      audit.append({ event: 'test.append_only.insert', metadata: { reason: 'ok' } }),
    ).resolves.toBeUndefined();
  });

  it('refuses UPDATE for the application role', async () => {
    const audit = createAuditLogRepository(db);
    const event = `test.append_only.update.${newId()}`;
    await audit.append({ event });

    await expect(
      db.$executeRawUnsafe(`UPDATE audit_log SET event = 'tampered' WHERE event = $1`, event),
    ).rejects.toThrow();

    const still = await db.auditLog.count({ where: { event } });
    expect(still).toBe(1);
  });

  it('refuses DELETE for the application role', async () => {
    const audit = createAuditLogRepository(db);
    const event = `test.append_only.delete.${newId()}`;
    await audit.append({ event });

    await expect(
      db.$executeRawUnsafe(`DELETE FROM audit_log WHERE event = $1`, event),
    ).rejects.toThrow();

    expect(await db.auditLog.count({ where: { event } })).toBe(1);
  });

  it('refuses UPDATE and DELETE even for the schema owner (trigger, defence in depth)', async () => {
    const event = `test.append_only.owner.${newId()}`;
    await createAuditLogRepository(db).append({ event });

    await expect(
      owner.$executeRawUnsafe(`UPDATE audit_log SET event = 'tampered' WHERE event = $1`, event),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.$executeRawUnsafe(`DELETE FROM audit_log WHERE event = $1`, event),
    ).rejects.toThrow(/append-only/);
  });
});

describe('least privilege (rule 109)', () => {
  it('denies DDL to the application role', async () => {
    await expect(
      db.$executeRawUnsafe(`CREATE TABLE should_not_exist (id integer)`),
    ).rejects.toThrow();
  });

  it('still allows ordinary writes to non-audit tables', async () => {
    const userId = await makeUser();
    expect(userId).toBeTruthy();
    await expect(
      db.user.update({ where: { id: userId }, data: { displayName: 'Renamed' } }),
    ).resolves.toBeTruthy();
  });
});

describe('withTransaction (rules 90-91)', () => {
  it('commits all writes together', async () => {
    const userId = await makeUser();
    const sessionId = await withTransaction(db, async (tx) => {
      const sessions = createSessionRepository(tx);
      const audit = createAuditLogRepository(tx);
      const session = await sessions.create({
        userId,
        tokenHash: new Uint8Array(32).fill(1),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await audit.append({
        actorUserId: userId,
        event: 'test.tx.commit',
        targetId: session.id,
      });
      return session.id;
    });

    expect(await db.session.count({ where: { id: sessionId } })).toBe(1);
  });

  it('rolls every write back when the callback throws', async () => {
    const userId = await makeUser();
    const tokenHash = new Uint8Array(32).fill(2);

    await expect(
      withTransaction(db, async (tx) => {
        await createSessionRepository(tx).create({
          userId,
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000),
        });
        throw new Error('deliberate failure after the write');
      }),
    ).rejects.toThrow('deliberate failure');

    expect(await db.session.count({ where: { userId } })).toBe(0);
  });

  it('defaults to Serializable', async () => {
    const level = await withTransaction(db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ transaction_isolation: string }>>(
        'SHOW transaction_isolation',
      );
      return rows[0]?.transaction_isolation;
    });
    expect(level).toBe('serializable');
  });
});

describe('session repository', () => {
  it('finds a live session by hash and ignores revoked and expired ones (rules 102, 125)', async () => {
    const userId = await makeUser();
    const sessions = createSessionRepository(db);
    const now = new Date();

    const live = await sessions.create({
      userId,
      tokenHash: new Uint8Array(32).fill(3),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const expired = await sessions.create({
      userId,
      tokenHash: new Uint8Array(32).fill(4),
      expiresAt: new Date(now.getTime() - 1_000),
    });
    const revoked = await sessions.create({
      userId,
      tokenHash: new Uint8Array(32).fill(5),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await sessions.revoke(revoked.id, userId);

    expect(await sessions.findLiveByTokenHash(new Uint8Array(32).fill(3), now)).toMatchObject({
      id: live.id,
    });
    expect(await sessions.findLiveByTokenHash(new Uint8Array(32).fill(4), now)).toBeNull();
    expect(await sessions.findLiveByTokenHash(new Uint8Array(32).fill(5), now)).toBeNull();
    expect(expired.id).toBeTruthy();
  });

  it("will not let one user revoke another user's session (master-prompt rule 161)", async () => {
    const alice = await makeUser();
    const mallory = await makeUser();
    const sessions = createSessionRepository(db);

    const aliceSession = await sessions.create({
      userId: alice,
      tokenHash: new Uint8Array(32).fill(6),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(await sessions.revoke(aliceSession.id, mallory)).toBe(false);
    expect(
      await sessions.findLiveByTokenHash(new Uint8Array(32).fill(6), new Date()),
    ).not.toBeNull();
  });

  it('revokes every other session on a credential change (rule 128)', async () => {
    const userId = await makeUser();
    const sessions = createSessionRepository(db);
    const keep = await sessions.create({
      userId,
      tokenHash: new Uint8Array(32).fill(7),
      expiresAt: new Date(Date.now() + 60_000),
    });
    for (const fill of [8, 9, 10]) {
      await sessions.create({
        userId,
        tokenHash: new Uint8Array(32).fill(fill),
        expiresAt: new Date(Date.now() + 60_000),
      });
    }

    expect(await sessions.revokeAllForUser(userId, keep.id)).toBe(3);
    const live = await sessions.listLiveByUser(userId, new Date());
    expect(live.map((s) => s.id)).toEqual([keep.id]);
  });
});

describe('credential repository', () => {
  it('refuses a duplicate credential id (rule 98)', async () => {
    const userId = await makeUser();
    const credentials = createCredentialRepository(db);
    const credentialId = new Uint8Array(16).fill(11);

    await credentials.createWebAuthn({
      userId,
      credentialId,
      publicKey: new Uint8Array(32).fill(1),
      signCount: 0n,
      transports: ['internal'],
    });

    await expect(
      credentials.createWebAuthn({
        userId,
        credentialId,
        publicKey: new Uint8Array(32).fill(2),
        signCount: 0n,
        transports: [],
      }),
    ).rejects.toThrow();
  });

  it('counts only credentials that can actually authenticate (rule 118)', async () => {
    const userId = await makeUser();
    const credentials = createCredentialRepository(db);

    await credentials.createWebAuthn({
      userId,
      credentialId: new Uint8Array(16).fill(12),
      publicKey: new Uint8Array(32).fill(1),
      signCount: 0n,
      transports: [],
    });
    // A TOTP credential is a second factor, never a way in on its own.
    await credentials.createTotp({ userId, secretEncrypted: new Uint8Array(48).fill(1) });

    expect(await credentials.countActiveAuthFactors(userId)).toBe(1);
  });

  it('excludes revoked credentials from lookup', async () => {
    const userId = await makeUser();
    const credentials = createCredentialRepository(db);
    const credentialId = new Uint8Array(16).fill(13);
    const created = await credentials.createWebAuthn({
      userId,
      credentialId,
      publicKey: new Uint8Array(32).fill(1),
      signCount: 0n,
      transports: [],
    });

    expect(await credentials.findWebAuthnByCredentialId(credentialId)).not.toBeNull();
    expect(await credentials.revoke(created.id, userId)).toBe(true);
    expect(await credentials.findWebAuthnByCredentialId(credentialId)).toBeNull();
    // Revoking twice is not an error, but it is not a second success either.
    expect(await credentials.revoke(created.id, userId)).toBe(false);
  });
});

describe('recovery codes (rule 133)', () => {
  it('lets a code be spent exactly once, even under concurrency', async () => {
    const userId = await makeUser();
    const codes = createRecoveryCodeRepository(db);
    const codeHash = new Uint8Array(32).fill(21);
    await codes.replaceAllForUser(userId, [codeHash, new Uint8Array(32).fill(22)]);

    const results = await Promise.all([
      codes.consume(userId, codeHash),
      codes.consume(userId, codeHash),
      codes.consume(userId, codeHash),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await codes.countUnused(userId)).toBe(1);
  });
});
