import { z } from 'zod';
import { ERROR_CODES } from '../error-codes.js';

/**
 * The single error response shape. Every non-2xx response from the API matches
 * this (prompt_phase1.md rules 83-85, 185).
 *
 * `detail` is deliberately absent: internal context never crosses the boundary
 * (rule 84). `correlationId` is what a user quotes when reporting a failure,
 * and what ties their report to the server logs (rules 72, 167).
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    correlationId: z.string(),
    /** Present only on VALIDATION_FAILED; field paths, never values. */
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /** Present only on STEP_UP_REQUIRED; seconds. */
    stepUpMaxAgeSeconds: z.number().int().positive().optional(),
    /** Present only on RATE_LIMITED; seconds. */
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const okSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof okSchema>;

export const idParamSchema = z.object({ id: z.string().min(1) });
