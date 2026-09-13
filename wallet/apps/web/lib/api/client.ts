import type { z } from 'zod';
import { errorResponseSchema, type ErrorCode } from '@wallet/types';

/**
 * THE ONLY PLACE fetch IS CALLED (prompt_phase1.md rules 159-160).
 *
 * Enforced by the `no-restricted-globals` rule in eslint.config.js, which
 * exempts exactly this directory. Everything else in the app calls a typed
 * function from ./endpoints.ts.
 *
 * The point is not tidiness. It is that credentials, error handling, response
 * parsing, and the correlation-id header are decided once. A component that
 * calls fetch directly forgets `credentials: 'include'` and the session simply
 * never arrives — and that failure looks like a backend bug.
 */

import { publicConfig } from '../config';
import { clusterHeader } from './cluster';

const API_BASE = publicConfig.apiBaseUrl;

/** The shape the API promises for every failure. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly correlationId: string;
  readonly fields: ReadonlyArray<{ path: string; message: string }>;
  readonly stepUpMaxAgeSeconds: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, body: z.infer<typeof errorResponseSchema>['error']) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.correlationId = body.correlationId;
    this.fields = body.fields ?? [];
    this.stepUpMaxAgeSeconds = body.stepUpMaxAgeSeconds;
    this.retryAfterSeconds = body.retryAfterSeconds;
  }

  /** True when the caller should run a step-up ceremony and retry (rule 137). */
  get needsStepUp(): boolean {
    return this.code === 'STEP_UP_REQUIRED';
  }

  get isUnauthenticated(): boolean {
    return this.code === 'AUTHENTICATION_REQUIRED' || this.code === 'SESSION_EXPIRED';
  }
}

/** A network failure or a response that did not match the contract at all. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

export interface RequestOptions<TResponse> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  /**
   * Every response is parsed, never cast (rule 162).
   *
   * The input type is `unknown` because branded schemas transform on parse:
   * `baseUnitsSchema` accepts a plain string and produces a branded one, so a
   * schema's input and output types differ and the default `z.ZodType<T>`
   * (which assumes they match) would not accept it.
   */
  readonly schema: z.ZodType<TResponse, z.ZodTypeDef, unknown>;
}

export async function request<TResponse>(options: RequestOptions<TResponse>): Promise<TResponse> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${options.path}`, {
      method: options.method,
      // Without this the session cookie is never sent and every authenticated
      // call fails as if the user were logged out.
      credentials: 'include',
      headers: {
        // Which chain this request is about (ADR-0021). Attached here, once,
        // for the same reason `credentials` is: a call site that forgot it
        // would silently be answered for the server's default cluster, and
        // the numbers it rendered would belong to a different network.
        ...clusterHeader(),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (cause) {
    throw new TransportError('Could not reach the server', { cause });
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch (cause) {
    throw new TransportError('The server returned something that was not JSON', { cause });
  }

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(json);
    if (!parsed.success) {
      // The server broke its own contract. Surfacing the correlation id is
      // still useful, so carry what we can.
      throw new TransportError(`Request failed with status ${response.status}`);
    }
    throw new ApiError(response.status, parsed.data.error);
  }

  // Parsing, not casting: a server that changes shape fails loudly here rather
  // than as `undefined is not an object` three components deep (rule 162).
  const parsed = options.schema.safeParse(json);
  if (!parsed.success) {
    throw new TransportError('The server returned an unexpected response shape');
  }
  return parsed.data;
}
