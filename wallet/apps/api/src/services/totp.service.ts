import { NotFoundError, ValidationError } from '@wallet/errors';
import { logSecurityEvent } from '@wallet/logger';
import { withTransaction } from '@wallet/db';
import type { TotpEnrollResponse, TotpVerifyResponse } from '@wallet/types';
import type { AppDeps, RequestMeta } from './deps.js';

export interface TotpEnrollmentService {
  enroll(userId: string, accountName: string): Promise<TotpEnrollResponse>;
  confirm(input: {
    userId: string;
    enrollmentId: string;
    code: string;
    meta: RequestMeta;
  }): Promise<TotpVerifyResponse>;
  disable(userId: string, meta: RequestMeta): Promise<void>;
}

export function createTotpEnrollmentService(deps: AppDeps): TotpEnrollmentService {
  return {
    /**
     * The one and only response that ever carries the plaintext secret
     * (rule 134). It is encrypted before it touches the database and is never
     * readable through any other endpoint.
     */
    async enroll(userId, accountName) {
      const secret = deps.totp.generateSecret();
      const encrypted = deps.totp.encryptSecret(secret);
      const { id } = await deps.credentials.createTotp({ userId, secretEncrypted: encrypted });

      return {
        secret,
        otpauthUri: deps.totp.buildUri(secret, accountName),
        enrollmentId: id,
      };
    },

    /**
     * Enrollment is only real once the user proves the authenticator works.
     * Confirming here, rather than at enroll time, is what stops a user
     * locking themselves out with a secret they never successfully scanned.
     */
    async confirm(input) {
      const pending = await deps.credentials.findUnconfirmedTotp(input.enrollmentId, input.userId);
      if (!pending || pending.totpSecretEncrypted === null) {
        throw new NotFoundError('No pending enrollment found');
      }

      const secret = deps.totp.decryptSecret(pending.totpSecretEncrypted);
      if (!deps.totp.verify(secret, input.code)) {
        logSecurityEvent(deps.logger, 'totp.verification_failed', {
          outcome: 'failure',
          userId: input.userId,
        });
        // Field path, not the code the user typed (rule 77).
        throw new ValidationError([{ path: 'code', message: 'That code is not valid' }]);
      }

      const { plaintext, hashes } = deps.totp.generateRecoveryCodes();

      await withTransaction(deps.db, async (tx) => {
        await deps.credentials.confirmTotp(input.enrollmentId, tx);
        await deps.recoveryCodes.replaceAllForUser(input.userId, hashes, tx);
        await deps.audit.append(
          {
            actorUserId: input.userId,
            event: 'totp.enrolled',
            targetType: 'credential',
            targetId: input.enrollmentId,
            metadata: { credentialType: 'totp' },
            correlationId: input.meta.correlationId,
            ip: input.meta.ip,
          },
          tx,
        );
      });

      // A new factor invalidates every other session (rule 128). The caller's
      // own session survives; every other one has to re-authenticate.
      if (input.meta.sessionId !== undefined) {
        await deps.sessions.revokeAllOthers(input.userId, input.meta.sessionId);
      }

      logSecurityEvent(deps.logger, 'totp.enrolled', { outcome: 'success', userId: input.userId });

      // Shown exactly once. There is no endpoint that returns these again.
      return { ok: true, recoveryCodes: plaintext };
    },

    async disable(userId, meta) {
      const confirmed = await deps.credentials.findConfirmedTotp(userId);
      if (!confirmed) throw new NotFoundError('Two-factor authentication is not enabled');

      await withTransaction(deps.db, async (tx) => {
        await deps.credentials.revoke(confirmed.id, userId, tx);
        await deps.recoveryCodes.deleteAllForUser(userId, tx);
        await deps.audit.append(
          {
            actorUserId: userId,
            event: 'totp.disabled',
            targetType: 'credential',
            targetId: confirmed.id,
            correlationId: meta.correlationId,
            ip: meta.ip,
          },
          tx,
        );
      });

      logSecurityEvent(deps.logger, 'totp.disabled', { outcome: 'success', userId });
    },
  };
}
