import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  currentSessionResponseSchema,
  errorResponseSchema,
  idParamSchema,
  listCredentialsResponseSchema,
  listSessionsResponseSchema,
  loginOptionsRequestSchema,
  loginOptionsResponseSchema,
  loginVerifyRequestSchema,
  okSchema,
  registerOptionsRequestSchema,
  registerOptionsResponseSchema,
  registerVerifyRequestSchema,
  stepUpOptionsResponseSchema,
  stepUpVerifyRequestSchema,
  stepUpVerifyResponseSchema,
  totpEnrollResponseSchema,
  totpVerifyRequestSchema,
  totpVerifyResponseSchema,
} from '@wallet/types';
import { clearedCookieAttributes, sessionCookieAttributes, type CookiePolicy } from '@wallet/auth';
import { logSecurityEvent } from '@wallet/logger';
import { requireSessionRecord } from '../middleware/guards.js';
import type { AuthControllers } from '../controllers/auth.controller.js';

export interface AuthRouteDeps {
  readonly controllers: AuthControllers;
  readonly cookiePolicy: CookiePolicy;
  readonly sessionGuard: (request: never, reply: never) => Promise<void>;
  readonly stepUpGuard: (request: never, reply: never) => Promise<void>;
  readonly csrfGuard: (request: never, reply: never) => Promise<void>;
  readonly authRateLimit: { max: number; timeWindow: string };
}

/**
 * Routes translate HTTP into commands and back (rules 62, 144).
 *
 * There is no business logic below this line: no database access, no policy
 * decision, no branching on domain state. Every handler validates, delegates to
 * a controller, and shapes the response.
 */
export function createAuthRoutes(deps: AuthRouteDeps): FastifyPluginAsyncZod {
  const { controllers: c } = deps;
  const errors = {
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
  };

  return async (app) => {
    const authLimit = { rateLimit: deps.authRateLimit };

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------
    app.post(
      '/auth/register/options',
      {
        config: authLimit,
        preValidation: [deps.csrfGuard as never],
        schema: {
          body: registerOptionsRequestSchema,
          response: { 200: registerOptionsResponseSchema, ...errors },
        },
      },
      async (request) => c.beginRegistration(request as never),
    );

    app.post(
      '/auth/register/verify',
      {
        config: authLimit,
        preValidation: [deps.csrfGuard as never],
        schema: {
          body: registerVerifyRequestSchema,
          response: { 200: currentSessionResponseSchema, ...errors },
        },
      },
      async (request, reply) => {
        const result = await c.finishRegistration(request as never);
        if (result.sessionToken !== null) {
          void reply.setCookie(
            deps.cookiePolicy.name,
            result.sessionToken,
            sessionCookieAttributes(deps.cookiePolicy),
          );
        }
        return result.body;
      },
    );

    // -----------------------------------------------------------------------
    // Login
    // -----------------------------------------------------------------------
    app.post(
      '/auth/login/options',
      {
        config: authLimit,
        preValidation: [deps.csrfGuard as never],
        schema: {
          body: loginOptionsRequestSchema,
          response: { 200: loginOptionsResponseSchema, ...errors },
        },
      },
      async () => c.beginLogin(),
    );

    app.post(
      '/auth/login/verify',
      {
        config: authLimit,
        preValidation: [deps.csrfGuard as never],
        schema: {
          body: loginVerifyRequestSchema,
          response: { 200: currentSessionResponseSchema, ...errors },
        },
      },
      async (request, reply) => {
        const result = await c.finishLogin(request as never);
        void reply.setCookie(
          deps.cookiePolicy.name,
          result.sessionToken,
          sessionCookieAttributes(deps.cookiePolicy),
        );
        return result.body;
      },
    );

    app.post(
      '/auth/logout',
      {
        preValidation: [deps.csrfGuard as never, deps.sessionGuard as never],
        schema: { response: { 200: okSchema, ...errors } },
      },
      async (request, reply) => {
        const { session, userId } = requireSessionRecord(request);
        await c.logout(userId, session.id, request as never);
        void reply.clearCookie(deps.cookiePolicy.name, clearedCookieAttributes(deps.cookiePolicy));
        logSecurityEvent(app.log2, 'auth.logout', { outcome: 'success', userId });
        return { ok: true as const };
      },
    );

    app.get(
      '/auth/session',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { response: { 200: currentSessionResponseSchema, ...errors } },
      },
      async (request) => c.currentSession(request as never),
    );

    // -----------------------------------------------------------------------
    // Step-up (rules 135-139)
    // -----------------------------------------------------------------------
    app.post(
      '/auth/step-up/options',
      {
        config: authLimit,
        preValidation: [deps.csrfGuard as never, deps.sessionGuard as never],
        schema: { response: { 200: stepUpOptionsResponseSchema, ...errors } },
      },
      async (request) => c.beginStepUp(request as never),
    );

    app.post(
      '/auth/step-up/verify',
      {
        config: authLimit,
        preValidation: [deps.csrfGuard as never, deps.sessionGuard as never],
        schema: {
          body: stepUpVerifyRequestSchema,
          response: { 200: stepUpVerifyResponseSchema, ...errors },
        },
      },
      async (request) => c.finishStepUp(request as never),
    );

    // -----------------------------------------------------------------------
    // Credentials — revocation demands a fresh assertion (rule 138)
    // -----------------------------------------------------------------------
    app.get(
      '/auth/credentials',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { response: { 200: listCredentialsResponseSchema, ...errors } },
      },
      async (request) => c.listCredentials(request as never),
    );

    app.delete(
      '/auth/credentials/:id',
      {
        preValidation: [
          deps.csrfGuard as never,
          deps.sessionGuard as never,
          deps.stepUpGuard as never,
        ],
        schema: { params: idParamSchema, response: { 200: okSchema, ...errors } },
      },
      async (request) => {
        await c.revokeCredential(request as never);
        return { ok: true as const };
      },
    );

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------
    app.get(
      '/auth/sessions',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { response: { 200: listSessionsResponseSchema, ...errors } },
      },
      async (request) => c.listSessions(request as never),
    );

    app.delete(
      '/auth/sessions/:id',
      {
        preValidation: [deps.csrfGuard as never, deps.sessionGuard as never],
        schema: { params: idParamSchema, response: { 200: okSchema, ...errors } },
      },
      async (request, reply) => {
        const { session } = requireSessionRecord(request);
        const params = request.params as { id: string };
        await c.revokeSession(request as never);
        // Revoking your own session is a logout.
        if (params.id === session.id) {
          void reply.clearCookie(
            deps.cookiePolicy.name,
            clearedCookieAttributes(deps.cookiePolicy),
          );
        }
        return { ok: true as const };
      },
    );

    // -----------------------------------------------------------------------
    // TOTP
    // -----------------------------------------------------------------------
    app.post(
      '/auth/2fa/enroll',
      {
        config: authLimit,
        preValidation: [
          deps.csrfGuard as never,
          deps.sessionGuard as never,
          deps.stepUpGuard as never,
        ],
        schema: { response: { 200: totpEnrollResponseSchema, ...errors } },
      },
      async (request) => c.enrollTotp(request as never),
    );

    app.post(
      '/auth/2fa/verify',
      {
        config: authLimit,
        preValidation: [deps.csrfGuard as never, deps.sessionGuard as never],
        schema: {
          body: totpVerifyRequestSchema,
          response: { 200: totpVerifyResponseSchema, ...errors },
        },
      },
      async (request) => c.confirmTotp(request as never),
    );

    app.delete(
      '/auth/2fa',
      {
        preValidation: [
          deps.csrfGuard as never,
          deps.sessionGuard as never,
          deps.stepUpGuard as never,
        ],
        schema: { response: { 200: okSchema, ...errors } },
      },
      async (request) => {
        await c.disableTotp(request as never);
        return { ok: true as const };
      },
    );

    // Declared so the response schema is exercised even though this route has
    // no body; keeps the contract honest under `noUnusedLocals`.
    void z;
  };
}
