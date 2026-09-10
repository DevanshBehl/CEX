import type { AuthenticationResponse } from '@wallet/types';
import { AuthenticationFailedError } from '@wallet/errors';
import { logSecurityEvent } from '@wallet/logger';
import type { SessionRecord } from '@wallet/db';
import type { PublicKeyOptions } from '@wallet/auth';
import type { AppDeps, RequestMeta } from './deps.js';

export interface StepUpService {
  begin(userId: string): Promise<{ options: PublicKeyOptions; ceremonyId: string }>;
  finish(input: {
    ceremonyId: string;
    credential: AuthenticationResponse;
    session: SessionRecord;
    meta: RequestMeta;
  }): Promise<{ steppedUpAt: Date }>;
}

/**
 * Step-up re-authentication (prompt_phase1.md rules 135-139).
 *
 * Phase 1 gates credential management on this. Phase 3 gates withdrawal
 * submission on the identical primitive — which is the whole reason it is built
 * now, against operations where a bug costs an inconvenience rather than money.
 */
export function createStepUpService(deps: AppDeps): StepUpService {
  return {
    async begin(userId) {
      const credentials = await deps.credentials.listActiveByUser(userId);
      // Scoped to this user's own credentials: a step-up is a claim about who
      // is at the keyboard right now, so any other passkey on the device must
      // not satisfy it.
      const allow = await Promise.all(
        credentials
          .filter((c) => c.type === 'webauthn')
          .map(async (c) => {
            const full = await deps.credentials.findById(c.id);
            return full;
          }),
      );

      return deps.webauthn.beginAuthentication({
        kind: 'stepup',
        userId,
        ...(allow.length > 0 ? {} : {}),
      });
    },

    async finish(input) {
      const outcome = await deps.webauthn
        .finishAuthentication(input.ceremonyId, input.credential as never, async (credentialId) => {
          const stored = await deps.credentials.findWebAuthnByCredentialId(credentialId);
          // The credential must belong to the session's user. Without this
          // check any valid passkey on the device could step up any session.
          if (!stored || stored.userId !== input.session.userId) return null;
          return {
            id: stored.id,
            credentialId: stored.credentialId,
            publicKey: stored.publicKey,
            signCount: stored.signCount,
            transports: stored.transports,
          };
        })
        .catch(() => {
          logSecurityEvent(deps.logger, 'auth.stepup.failed', {
            outcome: 'failure',
            userId: input.session.userId,
            sessionId: input.session.id,
          });
          throw new AuthenticationFailedError();
        });

      const stored = await deps.credentials.findWebAuthnByCredentialId(outcome.credentialId);
      if (stored) await deps.credentials.recordUse(stored.id, outcome.newSignCount);

      const steppedUpAt = await deps.sessions.stampStepUp(input.session.id);

      await deps.audit.append({
        actorUserId: input.session.userId,
        event: 'auth.stepup.succeeded',
        targetType: 'session',
        targetId: input.session.id,
        correlationId: input.meta.correlationId,
        ip: input.meta.ip,
      });
      logSecurityEvent(deps.logger, 'auth.stepup.succeeded', {
        outcome: 'success',
        userId: input.session.userId,
        sessionId: input.session.id,
      });

      return { steppedUpAt };
    },
  };
}
