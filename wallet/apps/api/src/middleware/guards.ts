import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionManager } from '@wallet/auth';
import { checkCsrf } from '@wallet/auth';
import type { SessionRecord } from '@wallet/db';
import { AuthenticationRequiredError, AuthorizationDeniedError } from '@wallet/errors';
import { attachIdentity, logSecurityEvent, type Logger } from '@wallet/logger';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionRecord;
    userId?: string;
  }
}

/**
 * These are registered as `preValidation`, not `preHandler`.
 *
 * Fastify runs preValidation BEFORE schema validation and preHandler after.
 * Registered as preHandler, an unauthenticated request to a route with a body
 * schema is answered 400 VALIDATION_FAILED — the server describes the shape of
 * a protected endpoint to a caller it has not yet authenticated, and the client
 * gets a misleading error. Authenticate first, then validate.
 */
export interface GuardDeps {
  readonly sessions: SessionManager;
  readonly cookieName: string;
  readonly webOrigin: string;
  readonly logger: Logger;
}

/**
 * CSRF defence, applied to every state-changing request (rule 129).
 *
 * This runs alongside SameSite=Strict on the cookie rather than instead of it.
 * Two independent mechanisms, failing for different reasons: one depends on the
 * browser behaving, this one depends only on the server.
 */
export function createCsrfGuard(deps: GuardDeps) {
  return async function csrfGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const verdict = checkCsrf({
      method: request.method,
      origin: header(request, 'origin'),
      secFetchSite: header(request, 'sec-fetch-site'),
      expectedOrigin: deps.webOrigin,
    });

    if (!verdict.ok) {
      deps.logger.warn('csrf check failed', {
        reason: verdict.reason,
        route: request.routeOptions.url ?? request.url,
        method: request.method,
      });
      throw new AuthorizationDeniedError('Request origin is not allowed');
    }
  };
}

/**
 * Resolves the session cookie into an authenticated request (rule 161).
 *
 * Authorization is decided here, on the server, from a cookie the client cannot
 * read or forge — never from anything the client asserts about itself
 * (rule 204, master-prompt rule 77).
 */
export function createSessionGuard(deps: GuardDeps) {
  return async function sessionGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = request.cookies[deps.cookieName];
    if (token === undefined || token.length === 0) throw new AuthenticationRequiredError();

    const context = await deps.sessions.resolve(token);
    if (!context) {
      logSecurityEvent(deps.logger, 'session.expired', { outcome: 'failure' });
      throw new AuthenticationRequiredError();
    }

    request.session = context.session;
    request.userId = context.userId;

    // From here on every log line in this request carries the user, without
    // any call site passing it (rule 70).
    attachIdentity({ userId: context.userId, sessionId: context.session.id });
  };
}

/**
 * Step-up guard (rules 135-139).
 *
 * Phase 3 puts exactly this in front of withdrawal submission. Phase 1 puts it
 * in front of credential and 2FA changes so the mechanism is exercised and
 * proven before any money depends on it.
 */
export function createStepUpGuard(deps: GuardDeps, maxAgeSeconds?: number) {
  return async function stepUpGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const session = request.session;
    if (!session) throw new AuthenticationRequiredError();
    // Throws StepUpRequiredError, which the error handler turns into a 403
    // carrying the required freshness so the client can prompt.
    deps.sessions.requireStepUp(session, maxAgeSeconds);
  };
}

export function requireSessionRecord(request: FastifyRequest): {
  session: SessionRecord;
  userId: string;
} {
  if (!request.session || request.userId === undefined) throw new AuthenticationRequiredError();
  return { session: request.session, userId: request.userId };
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
