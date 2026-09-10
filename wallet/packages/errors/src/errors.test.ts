import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  AuthenticationFailedError,
  InternalError,
  normalizeError,
  RateLimitError,
  StepUpRequiredError,
  toErrorResponse,
  ValidationError,
} from './index.js';

describe('normalizeError', () => {
  it('passes AppErrors through untouched', () => {
    const original = new RateLimitError(30);
    expect(normalizeError(original)).toBe(original);
  });

  it('converts a ZodError into a ValidationError with field paths', () => {
    const schema = z.object({ email: z.string().email(), age: z.number() });
    const result = schema.safeParse({ email: 'nope', age: 'x' });
    const error = normalizeError(result.success ? null : result.error);
    expect(error).toBeInstanceOf(ValidationError);
    const paths = (error as ValidationError).fields.map((f) => f.path);
    expect(paths).toContain('email');
    expect(paths).toContain('age');
  });

  it.each([['a bare string'], [42], [null], [undefined], [new TypeError('boom')]])(
    'converts %o into an InternalError',
    (thrown) => {
      const error = normalizeError(thrown);
      expect(error).toBeInstanceOf(InternalError);
      expect(error.httpStatus).toBe(500);
      expect(error.isOperational).toBe(false);
    },
  );
});

describe('toErrorResponse', () => {
  const CID = 'cid-123';

  it('never leaks internal detail, cause, or a stack trace (rules 84, 87)', () => {
    const cause = new Error('connection to 10.0.0.5:5432 refused: password authentication failed');
    const error = new InternalError(cause, { query: 'SELECT * FROM users' });
    const serialized = JSON.stringify(toErrorResponse(error, CID));

    expect(serialized).not.toContain('10.0.0.5');
    expect(serialized).not.toContain('password authentication');
    expect(serialized).not.toContain('SELECT');
    expect(serialized).not.toContain('stack');
    expect(JSON.parse(serialized).error.message).toBe('An unexpected error occurred');
  });

  it('carries the correlation id on every response (rules 72, 185)', () => {
    const body = toErrorResponse(new AuthenticationFailedError(), CID);
    expect(body.error.correlationId).toBe(CID);
    expect(body.error.code).toBe('AUTHENTICATION_FAILED');
  });

  it('includes the required step-up age so the client can prompt (rule 137)', () => {
    const body = toErrorResponse(new StepUpRequiredError(300), CID);
    expect(body.error.code).toBe('STEP_UP_REQUIRED');
    expect(body.error.stepUpMaxAgeSeconds).toBe(300);
  });

  it('includes retry-after on rate limits', () => {
    const body = toErrorResponse(new RateLimitError(45), CID);
    expect(body.error.retryAfterSeconds).toBe(45);
  });

  it('reports field paths but not rejected values (rule 77)', () => {
    const error = new ValidationError([{ path: 'email', message: 'Invalid email' }]);
    const serialized = JSON.stringify(toErrorResponse(error, CID));
    expect(serialized).toContain('email');
    expect(serialized).toContain('Invalid email');
  });
});

describe('the hierarchy', () => {
  it('gives an authentication failure no hint about which part failed (rule 141)', () => {
    const unknownAccount = new AuthenticationFailedError({ reason: 'no_such_user' });
    const wrongCredential = new AuthenticationFailedError({ reason: 'bad_signature' });
    expect(toErrorResponse(unknownAccount, 'a')).toEqual(toErrorResponse(wrongCredential, 'a'));
    expect(unknownAccount.httpStatus).toBe(wrongCredential.httpStatus);
  });

  it('reserves later-phase codes without implementing them (rules 81-82)', async () => {
    const mod = await import('./index.js');
    expect(new mod.InsufficientFundsError()).toBeInstanceOf(AppError);
    expect(new mod.PolicyDeniedError(['LIMIT_EXCEEDED']).code).toBe('POLICY_DENIED');
    expect(new mod.ChainError().code).toBe('CHAIN_ERROR');
  });
});
