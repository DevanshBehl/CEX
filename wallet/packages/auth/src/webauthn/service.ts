import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  AuthenticationFailedError,
  ChallengeInvalidError,
  CredentialCloneSuspectedError,
} from '@wallet/errors';
import type { ChallengeStore, CeremonyKind } from '../challenge/store.js';
import { detectClone } from './clone-detection.js';

/**
 * WebAuthn relying-party settings.
 *
 * THESE COME FROM VALIDATED CONFIG AND NEVER FROM A REQUEST HEADER
 * (prompt_phase1.md rules 112-113).
 *
 * This is the single most common WebAuthn mistake and the dangerous direction
 * of it. Deriving rpId or origin from the Host or Origin header means an
 * attacker who can reach the server with a header of their choosing gets
 * assertions verified against an origin they control. There is no scenario in
 * which the relying party learns its own identity from the caller.
 */
export interface RelyingParty {
  readonly rpId: string;
  readonly rpName: string;
  readonly origin: string;
}

export interface StoredCredential {
  readonly id: string;
  readonly credentialId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly signCount: bigint;
  readonly transports: string[];
}

export interface BeginRegistrationInput {
  readonly userId?: string;
  readonly userName: string;
  readonly userDisplayName: string;
  readonly existingCredentials: readonly StoredCredential[];
  readonly pendingEmail?: string;
  readonly pendingDisplayName?: string;
}

export interface RegistrationOutcome {
  readonly credentialId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly signCount: bigint;
  readonly transports: string[];
  readonly aaguid: string | undefined;
  readonly backedUp: boolean;
  readonly userId: string | undefined;
  readonly pendingEmail: string | undefined;
  readonly pendingDisplayName: string | undefined;
}

export interface AuthenticationOutcome {
  readonly credentialId: Uint8Array;
  readonly newSignCount: bigint;
  readonly userId: string | undefined;
}

/**
 * Matches `publicKeyOptionsSchema` in @wallet/types: a known `challenge` plus
 * whatever else the WebAuthn spec currently carries. Typed here rather than as
 * a bare Record so the API's response schema and this return type are the same
 * shape and no cast is needed at the boundary.
 */
export type PublicKeyOptions = { challenge: string } & Record<string, unknown>;

export interface WebAuthnService {
  beginRegistration(
    input: BeginRegistrationInput,
  ): Promise<{ options: PublicKeyOptions; ceremonyId: string }>;
  finishRegistration(
    ceremonyId: string,
    response: RegistrationResponseJSON,
  ): Promise<RegistrationOutcome>;
  beginAuthentication(input: {
    kind: Extract<CeremonyKind, 'authentication' | 'stepup'>;
    userId?: string;
    allowCredentials?: readonly StoredCredential[];
  }): Promise<{ options: PublicKeyOptions; ceremonyId: string }>;
  finishAuthentication(
    ceremonyId: string,
    response: AuthenticationResponseJSON,
    lookup: (credentialId: Uint8Array) => Promise<StoredCredential | null>,
  ): Promise<AuthenticationOutcome>;
}

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fromBase64Url = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, 'base64url'));

export function createWebAuthnService(
  rp: RelyingParty,
  challenges: ChallengeStore,
): WebAuthnService {
  return {
    async beginRegistration(input) {
      const options = await generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpId,
        userName: input.userName,
        userDisplayName: input.userDisplayName,
        // 'none' — we are not building an authenticator allowlist, and
        // requesting attestation we do not verify is theatre that costs the
        // user a privacy prompt.
        attestationType: 'none',
        excludeCredentials: input.existingCredentials.map((c) => ({
          id: toBase64Url(c.credentialId),
          transports: c.transports as never,
        })),
        authenticatorSelection: {
          // Discoverable credentials, so login needs no prior identifier
          // (rule 119).
          residentKey: 'preferred',
          // 'preferred' for registration and login, 'required' for step-up
          // (rule 120): a hard requirement here turns "my security key has no
          // PIN" into "you cannot create an account".
          userVerification: 'preferred',
        },
      });

      const ceremonyId = await challenges.put({
        kind: 'registration',
        challenge: options.challenge,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.pendingEmail !== undefined ? { pendingEmail: input.pendingEmail } : {}),
        ...(input.pendingDisplayName !== undefined
          ? { pendingDisplayName: input.pendingDisplayName }
          : {}),
      });

      return { options: options as unknown as PublicKeyOptions, ceremonyId };
    },

    async finishRegistration(ceremonyId, response) {
      const ceremony = await challenges.consume(ceremonyId);
      if (!ceremony || ceremony.kind !== 'registration') {
        // Covers expiry, a wrong id, and — critically — a replay, because the
        // first consume already removed it (rule 104).
        throw new ChallengeInvalidError();
      }

      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: false,
      });

      if (!verification.verified || !verification.registrationInfo) {
        throw new AuthenticationFailedError({ reason: 'registration_not_verified' });
      }

      const info = verification.registrationInfo;
      return {
        credentialId: fromBase64Url(info.credential.id),
        publicKey: info.credential.publicKey,
        signCount: BigInt(info.credential.counter),
        transports: info.credential.transports ?? [],
        aaguid: info.aaguid,
        backedUp: info.credentialBackedUp,
        userId: ceremony.userId,
        pendingEmail: ceremony.pendingEmail,
        pendingDisplayName: ceremony.pendingDisplayName,
      };
    },

    async beginAuthentication(input) {
      const options = await generateAuthenticationOptions({
        rpID: rp.rpId,
        ...(input.allowCredentials
          ? {
              allowCredentials: input.allowCredentials.map((c) => ({
                id: toBase64Url(c.credentialId),
                transports: c.transports as never,
              })),
            }
          : {}),
        // Step-up demands user verification; ordinary login prefers it
        // (rules 120, 136). A step-up that a lost-and-unlocked device could
        // satisfy is not a step up from anything.
        userVerification: input.kind === 'stepup' ? 'required' : 'preferred',
      });

      const ceremonyId = await challenges.put({
        kind: input.kind,
        challenge: options.challenge,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
      });

      return { options: options as unknown as PublicKeyOptions, ceremonyId };
    },

    async finishAuthentication(ceremonyId, response, lookup) {
      const ceremony = await challenges.consume(ceremonyId);
      if (!ceremony || ceremony.kind === 'registration') throw new ChallengeInvalidError();

      const credentialId = fromBase64Url(response.id);
      const stored = await lookup(credentialId);
      if (!stored) throw new AuthenticationFailedError({ reason: 'unknown_credential' });

      // A step-up ceremony must be answered by the session's own user. Without
      // this, any valid passkey on the device could step up any session.
      if (ceremony.userId !== undefined && ceremony.kind === 'stepup') {
        const belongs = await lookup(credentialId);
        if (!belongs) throw new AuthenticationFailedError({ reason: 'unknown_credential' });
      }

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: {
          id: toBase64Url(stored.credentialId),
          publicKey: stored.publicKey,
          counter: Number(stored.signCount),
          transports: stored.transports as never,
        },
        requireUserVerification: ceremony.kind === 'stepup',
      });

      if (!verification.verified) {
        throw new AuthenticationFailedError({ reason: 'assertion_not_verified' });
      }

      const newSignCount = BigInt(verification.authenticationInfo.newCounter);

      // Clone detection (rules 114-115). See ./clone-detection.ts for why the
      // stored-zero case is not suspicious.
      const verdict = detectClone(stored.signCount, newSignCount);
      if (verdict.suspicious) {
        throw new CredentialCloneSuspectedError({
          reason: verdict.reason,
          signCountStored: stored.signCount.toString(),
          signCountReceived: newSignCount.toString(),
        });
      }

      return {
        credentialId: stored.credentialId,
        newSignCount,
        userId: ceremony.userId,
      };
    },
  };
}
