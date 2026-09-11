import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  depositAddressResponseSchema,
  depositResponseSchema,
  errorResponseSchema,
  idParamSchema,
  listAddressesResponseSchema,
  listBalancesResponseSchema,
  listDepositsResponseSchema,
} from '@wallet/types';
import type { CustodyControllers } from '../controllers/custody.controller.js';

export interface CustodyRouteDeps {
  readonly controllers: CustodyControllers;
  readonly sessionGuard: (request: never, reply: never) => Promise<void>;
  readonly csrfGuard: (request: never, reply: never) => Promise<void>;
}

/**
 * Custody and deposit routes (prompt_phase2.md rules 167-170).
 *
 * Every route is session-guarded and scoped to the caller. Guards run at
 * `preValidation`, before schema validation — the Phase 1 lesson: registered as
 * `preHandler` they run after, and an unauthenticated request to a route with a
 * body schema gets a 400 describing the endpoint's shape instead of a 401.
 */
export function createCustodyRoutes(deps: CustodyRouteDeps): FastifyPluginAsyncZod {
  const { controllers: c } = deps;
  const errors = {
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
  };

  return async (app) => {
    app.post(
      '/wallets/addresses',
      {
        preValidation: [deps.csrfGuard as never, deps.sessionGuard as never],
        schema: { response: { 200: depositAddressResponseSchema, ...errors } },
      },
      async (request) => c.getDepositAddress(request as never),
    );

    app.get(
      '/wallets/:id/addresses',
      {
        preValidation: [deps.sessionGuard as never],
        schema: {
          params: idParamSchema,
          response: { 200: listAddressesResponseSchema, ...errors },
        },
      },
      async (request) => c.listAddresses(request as never),
    );

    app.get(
      '/balances',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { response: { 200: listBalancesResponseSchema, ...errors } },
      },
      async (request) => c.listBalances(request as never),
    );

    app.get(
      '/deposits',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { response: { 200: listDepositsResponseSchema, ...errors } },
      },
      async (request) => c.listDeposits(request as never),
    );

    app.get(
      '/deposits/:id',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { params: idParamSchema, response: { 200: depositResponseSchema, ...errors } },
      },
      async (request) => c.getDeposit(request as never),
    );
  };
}
