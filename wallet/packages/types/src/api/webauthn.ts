import { z } from 'zod';

/**
 * WebAuthn ceremony payloads (prompt_phase1.md rule 145).
 *
 * These mirror @simplewebauthn's RegistrationResponseJSON /
 * AuthenticationResponseJSON. They are declared here rather than imported so
 * that `packages/types` keeps zero runtime dependencies beyond Zod (rule 55)
 * and the browser bundle does not pull in a server library.
 *
 * Options objects are server-generated and passthrough-validated: the WebAuthn
 * spec surface evolves, and re-declaring it strictly here would mean this file
 * silently breaks ceremonies whenever the library adds a field.
 */

const base64url = z.string().min(1);

export const publicKeyOptionsSchema = z.object({ challenge: base64url }).passthrough();

export const registrationResponseSchema = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64url,
    attestationObject: base64url,
    transports: z.array(z.string()).optional(),
    publicKeyAlgorithm: z.number().optional(),
    publicKey: base64url.optional(),
    authenticatorData: base64url.optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.unknown()).default({}),
});
export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

export const authenticationResponseSchema = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: base64url.optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.unknown()).default({}),
});
export type AuthenticationResponse = z.infer<typeof authenticationResponseSchema>;
