import { z } from 'zod';
import { credentialTypeSchema } from './auth.js';

export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  emailVerified: z.boolean(),
  status: z.enum(['active', 'suspended', 'closed']),
  createdAt: z.string().datetime(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const currentSessionResponseSchema = z.object({
  user: userSummarySchema,
  session: z.object({
    id: z.string(),
    createdAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    /** null when the session has never completed a step-up (rules 135-137). */
    stepUpAt: z.string().datetime().nullable(),
  }),
  factors: z.array(credentialTypeSchema),
});
export type CurrentSessionResponse = z.infer<typeof currentSessionResponseSchema>;

export const sessionSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
});
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;
