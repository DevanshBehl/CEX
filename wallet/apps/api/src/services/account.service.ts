import { ConflictError, LastFactorProtectedError, NotFoundError } from '@wallet/errors';
import { logSecurityEvent } from '@wallet/logger';
import { withTransaction } from '@wallet/db';
import type {
  CredentialSummary,
  ListCredentialsResponse,
  ListSessionsResponse,
  UserSummary,
} from '@wallet/types';
import type { AppDeps, RequestMeta } from './deps.js';

export interface AccountService {
  getUser(userId: string): Promise<UserSummary>;
  updateUser(
    userId: string,
    patch: { displayName?: string | undefined; email?: string | undefined },
    meta: RequestMeta,
  ): Promise<UserSummary>;
  listCredentials(userId: string): Promise<ListCredentialsResponse>;
  revokeCredential(userId: string, credentialId: string, meta: RequestMeta): Promise<void>;
  listSessions(userId: string, currentSessionId: string): Promise<ListSessionsResponse>;
  revokeSession(userId: string, sessionId: string, meta: RequestMeta): Promise<void>;
}

export function createAccountService(deps: AppDeps): AccountService {
  return {
    async getUser(userId) {
      const user = await deps.users.findById(userId);
      if (!user) throw new NotFoundError('Account not found');
      return toUserSummary(user);
    },

    async updateUser(userId, patch, meta) {
      if (patch.email !== undefined) {
        const taken = await deps.users.findByEmail(patch.email);
        if (taken !== null && taken.id !== userId) {
          throw new ConflictError('That email address is not available');
        }
      }
      const updated = await deps.users.update(userId, {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
      });
      await deps.audit.append({
        actorUserId: userId,
        event: 'user.updated',
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return toUserSummary(updated);
    },

    async listCredentials(userId) {
      const rows = await deps.credentials.listActiveByUser(userId);
      const credentials: CredentialSummary[] = rows.map((row) => ({
        id: row.id,
        type: row.type,
        deviceName: row.deviceName,
        transports: row.transports,
        backedUp: row.backedUp,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      }));
      return { credentials };
    },

    /**
     * Requires a step-up at the route level, and refuses to remove a user's
     * last way in (rule 118).
     *
     * The count is taken inside the transaction, so two concurrent revocations
     * cannot each see two factors and each remove one.
     */
    async revokeCredential(userId, credentialId, meta) {
      await withTransaction(deps.db, async (tx) => {
        const credential = await deps.credentials.findById(credentialId, tx);
        if (!credential || credential.userId !== userId) {
          // Someone else's credential id is reported as not found, never as
          // forbidden — a 403 would confirm the id exists.
          throw new NotFoundError('Credential not found');
        }

        if (credential.type !== 'totp') {
          const remaining = await deps.credentials.countActiveAuthFactors(userId, tx);
          if (remaining <= 1) throw new LastFactorProtectedError();
        }

        const revoked = await deps.credentials.revoke(credentialId, userId, tx);
        if (!revoked) throw new NotFoundError('Credential not found');

        await deps.audit.append(
          {
            actorUserId: userId,
            event: 'credential.revoked',
            targetType: 'credential',
            targetId: credentialId,
            metadata: { credentialType: credential.type },
            correlationId: meta.correlationId,
            ip: meta.ip,
          },
          tx,
        );
      });

      logSecurityEvent(deps.logger, 'credential.revoked', {
        outcome: 'success',
        userId,
        credentialId,
      });
    },

    async listSessions(userId, currentSessionId) {
      const rows = await deps.sessions.list(userId);
      return {
        sessions: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          ip: row.ip,
          userAgent: row.userAgent,
          current: row.id === currentSessionId,
        })),
      };
    },

    async revokeSession(userId, sessionId, meta) {
      const revoked = await deps.sessions.revoke(sessionId, userId);
      if (!revoked) throw new NotFoundError('Session not found');

      await deps.audit.append({
        actorUserId: userId,
        event: 'session.revoked',
        targetType: 'session',
        targetId: sessionId,
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      logSecurityEvent(deps.logger, 'session.revoked', {
        outcome: 'success',
        userId,
        sessionId,
      });
    },
  };
}

function toUserSummary(user: {
  id: string;
  email: string | null;
  displayName: string | null;
  emailVerifiedAt: Date | null;
  status: 'active' | 'suspended' | 'closed';
  createdAt: Date;
}): UserSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

export { toUserSummary };
