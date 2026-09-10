import type { RegistrationResponse } from '@wallet/types';
import { ConflictError } from '@wallet/errors';
import { logSecurityEvent } from '@wallet/logger';
import { withTransaction } from '@wallet/db';
import type { PublicKeyOptions } from '@wallet/auth';
import type { AppDeps, RequestMeta } from './deps.js';

export interface RegistrationService {
  begin(input: {
    email?: string | undefined;
    displayName?: string | undefined;
    userId?: string | undefined;
  }): Promise<{ options: PublicKeyOptions; ceremonyId: string }>;

  finish(input: {
    ceremonyId: string;
    credential: RegistrationResponse;
    deviceName?: string | undefined;
    /** Set when an already-authenticated user is adding another passkey. */
    userId?: string | undefined;
    meta: RequestMeta;
  }): Promise<{ userId: string; sessionToken: string | null; credentialId: string }>;
}

export function createRegistrationService(deps: AppDeps): RegistrationService {
  return {
    /**
     * Always issues a ceremony, whether or not the email is already taken.
     *
     * An endpoint that answers "that email exists" is a user-enumeration
     * oracle (rule 141), and it is free to answer here, so it does not.
     */
    async begin(input) {
      const existing =
        input.userId !== undefined ? await deps.credentials.listActiveByUser(input.userId) : [];

      const name = input.email ?? input.displayName ?? 'wallet user';

      const result = await deps.webauthn.beginRegistration({
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        userName: name,
        userDisplayName: input.displayName ?? name,
        // Stops the authenticator silently creating a second credential for a
        // passkey the account already has.
        existingCredentials: existing.map((c) => ({
          id: c.id,
          credentialId: new Uint8Array(),
          publicKey: new Uint8Array(),
          signCount: 0n,
          transports: c.transports,
        })),
        ...(input.email !== undefined ? { pendingEmail: input.email } : {}),
        ...(input.displayName !== undefined ? { pendingDisplayName: input.displayName } : {}),
      });

      logSecurityEvent(deps.logger, 'auth.registration.started', { outcome: 'success' });
      return result;
    },

    async finish(input) {
      const outcome = await deps.webauthn.finishRegistration(
        input.ceremonyId,
        input.credential as never,
      );

      const existingUserId = input.userId ?? outcome.userId;

      // One transaction: user, credential, and audit row commit together or
      // not at all. A credential without its audit row is a gap in the trail,
      // and an audit row without its credential is a lie (rule 86, 142).
      const result = await withTransaction(deps.db, async (tx) => {
        let userId = existingUserId;

        if (userId === undefined) {
          if (outcome.pendingEmail !== undefined) {
            const taken = await deps.users.findByEmail(outcome.pendingEmail, tx);
            if (taken !== null) {
              // See docs/adr/0002-authentication-model.md: this is the one
              // place registration is enumerable, and the fix is an email
              // verification loop, which Phase 1 has no mail transport for.
              throw new ConflictError('Registration could not be completed');
            }
          }
          const user = await deps.users.create(
            {
              email: outcome.pendingEmail,
              displayName: outcome.pendingDisplayName,
            },
            tx,
          );
          userId = user.id;
          await deps.audit.append(
            {
              actorUserId: userId,
              event: 'user.created',
              correlationId: input.meta.correlationId,
              ip: input.meta.ip,
            },
            tx,
          );
        }

        const credential = await deps.credentials.createWebAuthn(
          {
            userId,
            credentialId: outcome.credentialId,
            publicKey: outcome.publicKey,
            signCount: outcome.signCount,
            transports: outcome.transports,
            aaguid: outcome.aaguid,
            backedUp: outcome.backedUp,
            deviceName: input.deviceName,
          },
          tx,
        );

        await deps.audit.append(
          {
            actorUserId: userId,
            event: 'credential.registered',
            targetType: 'credential',
            targetId: credential.id,
            metadata: {
              credentialType: 'webauthn',
              transports: outcome.transports,
              backedUp: outcome.backedUp,
            },
            correlationId: input.meta.correlationId,
            ip: input.meta.ip,
          },
          tx,
        );

        return { userId, credentialId: credential.id, isNewUser: existingUserId === undefined };
      });

      // A brand-new account gets a session; an existing user adding a second
      // passkey keeps the session they already have.
      let sessionToken: string | null = null;
      if (result.isNewUser) {
        const issued = await deps.sessions.issue({
          userId: result.userId,
          ip: input.meta.ip,
          userAgent: input.meta.userAgent,
          // Registration IS a fresh user-verifying ceremony, so the session
          // starts stepped up.
          steppedUp: true,
        });
        sessionToken = issued.token;
        logSecurityEvent(deps.logger, 'session.created', {
          outcome: 'success',
          userId: result.userId,
          sessionId: issued.session.id,
        });
      } else if (input.meta.sessionId !== undefined) {
        // Adding a passkey to an existing account is a credential change, so
        // every other session has to re-authenticate (rule 128).
        await deps.sessions.revokeAllOthers(result.userId, input.meta.sessionId);
      }

      logSecurityEvent(deps.logger, 'auth.registration.completed', {
        outcome: 'success',
        userId: result.userId,
        credentialId: result.credentialId,
      });

      return { userId: result.userId, sessionToken, credentialId: result.credentialId };
    },
  };
}
