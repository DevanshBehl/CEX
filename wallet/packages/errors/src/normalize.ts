import { ZodError } from 'zod';
import type { ErrorResponse } from '@wallet/types';
import { AppError } from './app-error.js';
import {
  InternalError,
  RateLimitError,
  StepUpRequiredError,
  ValidationError,
  type FieldIssue,
} from './errors.js';

/**
 * Turns anything thrown anywhere into an AppError (prompt_phase1.md rule 86).
 * A thrown string, a driver error, a TypeError from a typo — all become
 * InternalError, keeping the original as `cause` for the logs only.
 */
export function normalizeError(thrown: unknown): AppError {
  if (thrown instanceof AppError) return thrown;

  if (thrown instanceof ZodError) {
    return new ValidationError(zodIssues(thrown));
  }

  return new InternalError(thrown, {
    originalName: thrown instanceof Error ? thrown.name : typeof thrown,
  });
}

export function zodIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    // issue.message describes the constraint, not the value — safe to return.
    message: issue.message,
  }));
}

/**
 * The one function that builds an error response body (rules 84-85).
 *
 * Note what is absent: `detail`, `cause`, and `stack`. There is no environment
 * flag that turns them on — a debug switch that leaks internals in production
 * is how internals leak in production (rule 87).
 */
export function toErrorResponse(error: AppError, correlationId: string): ErrorResponse {
  const body: ErrorResponse = {
    error: {
      code: error.code,
      message: error.clientMessage,
      correlationId,
    },
  };

  if (error instanceof ValidationError && error.fields.length > 0) {
    body.error.fields = [...error.fields];
  }
  if (error instanceof StepUpRequiredError) {
    body.error.stepUpMaxAgeSeconds = error.maxAgeSeconds;
  }
  if (error instanceof RateLimitError) {
    body.error.retryAfterSeconds = error.retryAfterSeconds;
  }

  return body;
}
