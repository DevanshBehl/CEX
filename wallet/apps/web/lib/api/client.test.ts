import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, request, TransportError } from './client';

/**
 * The client's contract (prompt_phase1.md rules 159-162).
 *
 * What matters is that a response is PARSED and not cast: a server that changes
 * shape must fail here, loudly, rather than three components deep as
 * "undefined is not an object".
 */
const schema = z.object({ ok: z.literal(true), value: z.number() });

function mockFetch(status: number, body: unknown, ok = status < 400): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status,
      text: async () => JSON.stringify(body),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('returns a parsed body on success', async () => {
    mockFetch(200, { ok: true, value: 42 });
    await expect(request({ method: 'GET', path: '/x', schema })).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });

  it('always sends credentials, or the session cookie never arrives', async () => {
    mockFetch(200, { ok: true, value: 1 });
    await request({ method: 'GET', path: '/x', schema });
    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect((call?.[1] as RequestInit).credentials).toBe('include');
  });

  it('rejects a response that does not match the schema, rather than passing it through', async () => {
    mockFetch(200, { ok: true, value: 'not-a-number' });
    await expect(request({ method: 'GET', path: '/x', schema })).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('rejects a body that is not JSON at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html>502</html>' })),
    );
    await expect(request({ method: 'GET', path: '/x', schema })).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('surfaces a network failure as a TransportError, not an unhandled rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(request({ method: 'GET', path: '/x', schema })).rejects.toBeInstanceOf(
      TransportError,
    );
  });
});

describe('ApiError', () => {
  const errorBody = (overrides: Record<string, unknown> = {}) => ({
    error: {
      code: 'STEP_UP_REQUIRED',
      message: 'Re-authentication required to continue',
      correlationId: 'cid-1',
      ...overrides,
    },
  });

  it('carries the code and correlation id from the contract', async () => {
    mockFetch(403, errorBody(), false);
    const error = await request({ method: 'GET', path: '/x', schema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('STEP_UP_REQUIRED');
    expect((error as ApiError).correlationId).toBe('cid-1');
  });

  it('exposes needsStepUp so a caller can prompt and retry (rule 137)', async () => {
    mockFetch(403, errorBody({ stepUpMaxAgeSeconds: 300 }), false);
    const error = (await request({ method: 'GET', path: '/x', schema }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.needsStepUp).toBe(true);
    expect(error.stepUpMaxAgeSeconds).toBe(300);
  });

  it('exposes isUnauthenticated so the session hook can reset', async () => {
    mockFetch(401, errorBody({ code: 'AUTHENTICATION_REQUIRED' }), false);
    const error = (await request({ method: 'GET', path: '/x', schema }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.isUnauthenticated).toBe(true);
    expect(error.needsStepUp).toBe(false);
  });

  it('carries validation field paths', async () => {
    mockFetch(
      400,
      errorBody({
        code: 'VALIDATION_FAILED',
        fields: [{ path: 'email', message: 'Invalid email' }],
      }),
      false,
    );
    const error = (await request({ method: 'GET', path: '/x', schema }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.fields).toEqual([{ path: 'email', message: 'Invalid email' }]);
  });

  it('falls back to TransportError when the server breaks its own error contract', async () => {
    mockFetch(500, { oops: 'not the agreed shape' }, false);
    await expect(request({ method: 'GET', path: '/x', schema })).rejects.toBeInstanceOf(
      TransportError,
    );
  });
});
