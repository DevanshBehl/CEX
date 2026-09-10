import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponseSchema, meResponseSchema, updateMeRequestSchema } from '@wallet/types';
import { requireSessionRecord } from '../middleware/guards.js';
import type { AccountService } from '../services/account.service.js';

export interface MeRouteDeps {
  readonly account: AccountService;
  readonly sessionGuard: (request: never, reply: never) => Promise<void>;
  readonly csrfGuard: (request: never, reply: never) => Promise<void>;
}

export function createMeRoutes(deps: MeRouteDeps): FastifyPluginAsyncZod {
  const errors = {
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  };

  return async (app) => {
    app.get(
      '/me',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { response: { 200: meResponseSchema, ...errors } },
      },
      async (request) => {
        const { userId } = requireSessionRecord(request);
        return { user: await deps.account.getUser(userId) };
      },
    );

    app.patch(
      '/me',
      {
        preValidation: [deps.csrfGuard as never, deps.sessionGuard as never],
        schema: { body: updateMeRequestSchema, response: { 200: meResponseSchema, ...errors } },
      },
      async (request) => {
        const { userId } = requireSessionRecord(request);
        const body = request.body as { displayName?: string; email?: string };
        const user = await deps.account.updateUser(userId, body, {
          ip: request.ip,
          correlationId: request.correlationId,
        });
        return { user };
      },
    );
  };
}
