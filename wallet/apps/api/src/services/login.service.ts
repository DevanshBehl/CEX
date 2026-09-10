import type { AuthenticationResponse } from '@wallet/types';
import { AuthenticationFailedError, CredentialCloneSuspectedError } from '@wallet/errors';
import { logSecurityEvent } from '@wallet/logger';
import type { PublicKeyOptions } from '@wallet/auth';
import type { AppDeps, RequestMeta } from './deps.js';

export interface LoginService {
  begin(): Promise<{ options: PublicKeyOptions; ceremonyId: string }>;
  finish(input: {
    ceremonyId: string;
    credential: AuthenticationResponse;
    meta: RequestMeta;
  }): Promise<{ userId: string; sessionToken: string }>;
}

export function createLoginService(deps: AppDeps): LoginService {
  return {
    /**
     * Takes no identifier and returns no allowCredentials list.
     *
     * This is what makes login non-enumerable (rules 119, 141, 179): there is
     * no input whose presence or absence in the database could change the
     * response, because the response does not depend on any account. The
     * authenticator names the user via a discoverable credential.
     */
    async begin() {
      logSecurityEvent(deps.logger, 'auth.login.started', { outcome: 'success' });
      return deps.webauthn.beginAuthentication({ kind: 'authentication' });
    },

    async finish(input) {
      let outcome;
      try {
        outcome = await deps.webauthn.finishAuthentication(
          input.ceremonyId,
          input.credential as never,
          async (credentialId) => {
            const stored = await deps.credentials.findWebAuthnByCredentialId(credentialId);
            if (!stored) return null;
            return {
              id: stored.id,
              credentialId: stored.credentialId,
              publicKey: stored.publicKey,
              signCount: stored.signCount,
              transports: stored.transports,
            };
          },
        );
      } catch (error) {
        if (error instanceof CredentialCloneSuspectedError) {
          // Rule 115: reject, audit, and create no session. The audit row is
          // the point — this is the signal a human needs to see.
          await deps.audit.append({
            event: 'credential.clone_suspected',
            targetType: 'credential',
            metadata: { reason: 'sign_count_did_not_advance' },
            correlationId: input.meta.correlationId,
            ip: input.meta.ip,
          });
          logSecurityEvent(deps.logger, 'credential.clone_suspected', { outcome: 'failure' });
        } else {
          logSecurityEvent(deps.logger, 'auth.login.failed', { outcome: 'failure' });
        }
        // Every failure leaves by the same door: same code, same status, same
        // body. An unknown credential, a bad signature, a replayed challenge,
        // and a suspected clone are indistinguishable to the caller (rule 141).
        throw new AuthenticationFailedError();
      }

      const stored = await deps.credentials.findWebAuthnByCredentialId(outcome.credentialId);
      if (!stored) throw new AuthenticationFailedError();

      const user = await deps.users.findById(stored.userId);
      if (!user || user.status !== 'active') {
        // A suspended account is also indistinguishable from a wrong credential.
        logSecurityEvent(deps.logger, 'auth.login.failed', {
          outcome: 'failure',
          userId: stored.userId,
          reason: 'account_not_active',
        });
        throw new AuthenticationFailedError();
      }

      await deps.credentials.recordUse(stored.id, outcome.newSignCount);

      const issued = await deps.sessions.issue({
        userId: user.id,
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
        // A passkey assertion is a fresh authentication, so the session begins
        // stepped up; the step-up clock then runs down from here.
        steppedUp: true,
      });

      await deps.audit.append({
        actorUserId: user.id,
        event: 'auth.login.succeeded',
        targetType: 'session',
        targetId: issued.session.id,
        metadata: { credentialType: 'webauthn', credentialId: stored.id },
        correlationId: input.meta.correlationId,
        ip: input.meta.ip,
      });

      logSecurityEvent(deps.logger, 'auth.login.succeeded', {
        outcome: 'success',
        userId: user.id,
        sessionId: issued.session.id,
        credentialId: stored.id,
      });

      return { userId: user.id, sessionToken: issued.token };
    },
  };
}
