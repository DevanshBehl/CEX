import { z } from 'zod';
import { displayNameSchema, emailSchema } from './auth.js';
import { userSummarySchema } from './session.js';

export const meResponseSchema = z.object({ user: userSummarySchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const updateMeRequestSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    email: emailSchema.optional(),
  })
  .refine((v) => v.displayName !== undefined || v.email !== undefined, {
    message: 'at least one field must be supplied',
  });
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
