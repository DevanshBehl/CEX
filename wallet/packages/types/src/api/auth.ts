import { z } from 'zod';
import {
  authenticationResponseSchema,
  publicKeyOptionsSchema,
  registrationResponseSchema,
} from './webauthn.js';

export const emailSchema = z.string().email().max(254).toLowerCase().trim();
export const displayNameSchema = z.string().min(1).max(64).trim();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Email is optional: a passkey-only account is a first-class citizen
 * (prompt_phase1.md rule 130).
 */
export const registerOptionsRequestSchema = z.object({
  email: emailSchema.optional(),
  displayName: displayNameSchema.optional(),
});
export type RegisterOptionsRequest = z.infer<typeof registerOptionsRequestSchema>;

export const registerOptionsResponseSchema = z.object({
  options: publicKeyOptionsSchema,
  /** Opaque handle tying the verify call to this ceremony. Single-use (rule 104). */
  ceremonyId: z.string().min(1),
});
export type RegisterOptionsResponse = z.infer<typeof registerOptionsResponseSchema>;

export const registerVerifyRequestSchema = z.object({
  ceremonyId: z.string().min(1),
  credential: registrationResponseSchema,
  deviceName: z.string().min(1).max(64).trim().optional(),
});
export type RegisterVerifyRequest = z.infer<typeof registerVerifyRequestSchema>;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * No identifier is required — discoverable credentials let the authenticator
 * name the user (rule 119). An email may be supplied to narrow the allowlist,
 * but supplying an unknown one must be indistinguishable from a known one
 * (rule 141), so this endpoint always returns options.
 */
export const loginOptionsRequestSchema = z.object({
  email: emailSchema.optional(),
});
export type LoginOptionsRequest = z.infer<typeof loginOptionsRequestSchema>;

export const loginOptionsResponseSchema = z.object({
  options: publicKeyOptionsSchema,
  ceremonyId: z.string().min(1),
});
export type LoginOptionsResponse = z.infer<typeof loginOptionsResponseSchema>;

export const loginVerifyRequestSchema = z.object({
  ceremonyId: z.string().min(1),
  credential: authenticationResponseSchema,
});
export type LoginVerifyRequest = z.infer<typeof loginVerifyRequestSchema>;

// ---------------------------------------------------------------------------
// Step-up (prompt_phase1.md rules 135-139)
// ---------------------------------------------------------------------------

export const stepUpOptionsResponseSchema = z.object({
  options: publicKeyOptionsSchema,
  ceremonyId: z.string().min(1),
});
export type StepUpOptionsResponse = z.infer<typeof stepUpOptionsResponseSchema>;

export const stepUpVerifyRequestSchema = z.object({
  ceremonyId: z.string().min(1),
  credential: authenticationResponseSchema,
});
export type StepUpVerifyRequest = z.infer<typeof stepUpVerifyRequestSchema>;

export const stepUpVerifyResponseSchema = z.object({
  ok: z.literal(true),
  steppedUpAt: z.string().datetime(),
  validForSeconds: z.number().int().positive(),
});
export type StepUpVerifyResponse = z.infer<typeof stepUpVerifyResponseSchema>;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export const credentialTypeSchema = z.enum(['webauthn', 'password', 'totp']);
export type CredentialType = z.infer<typeof credentialTypeSchema>;

export const credentialSummarySchema = z.object({
  id: z.string(),
  type: credentialTypeSchema,
  deviceName: z.string().nullable(),
  transports: z.array(z.string()),
  backedUp: z.boolean().nullable(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
});
export type CredentialSummary = z.infer<typeof credentialSummarySchema>;

export const listCredentialsResponseSchema = z.object({
  credentials: z.array(credentialSummarySchema),
});
export type ListCredentialsResponse = z.infer<typeof listCredentialsResponseSchema>;

// ---------------------------------------------------------------------------
// TOTP (prompt_phase1.md rules 132-134)
// ---------------------------------------------------------------------------

export const totpEnrollResponseSchema = z.object({
  /** The only time the secret is ever transmitted (rule 134). */
  secret: z.string(),
  otpauthUri: z.string(),
  enrollmentId: z.string(),
});
export type TotpEnrollResponse = z.infer<typeof totpEnrollResponseSchema>;

export const totpVerifyRequestSchema = z.object({
  enrollmentId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'six digits'),
});
export type TotpVerifyRequest = z.infer<typeof totpVerifyRequestSchema>;

export const totpVerifyResponseSchema = z.object({
  ok: z.literal(true),
  /** Shown exactly once, never retrievable again (rule 133). */
  recoveryCodes: z.array(z.string()),
});
export type TotpVerifyResponse = z.infer<typeof totpVerifyResponseSchema>;
