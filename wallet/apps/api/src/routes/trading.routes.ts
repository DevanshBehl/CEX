import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  allocationRequestSchema,
  amendOrderSchema,
  cancelAllResponseSchema,
  errorResponseSchema,
  idParamSchema,
  listMarketsResponseSchema,
  listOrdersResponseSchema,
  listTradingBalancesResponseSchema,
  marketSymbolSchema,
  orderResponseSchema,
  placeOrderSchema,
  withdrawalResponseSchema,
} from '@wallet/types';
import type { TradingControllers } from '../controllers/trading.controller.js';

/**
 * Trading routes. Registered ONLY when TRADING_ENABLED is true — refused by
 * absence, not by a check that could be forgotten.
 *
 * What each action must prove (ADR-0033): orders need a session, because the
 * funds never leave the platform and a trader cannot re-assert a passkey fifty
 * times a minute. Allocation and deallocation move funds ON-CHAIN, so they
 * demand the same value-tiered step-up a withdrawal does.
 */
export interface TradingRouteDeps {
  readonly controllers: TradingControllers;
  readonly sessionGuard: (request: never, reply: never) => Promise<void>;
  readonly csrfGuard: (request: never, reply: never) => Promise<void>;
  readonly withdrawalStepUpGuard: (request: never, reply: never) => Promise<void>;
}

export function createTradingRoutes(deps: TradingRouteDeps): FastifyPluginAsyncZod {
  const { controllers: c } = deps;
  const errors = {
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    503: errorResponseSchema,
  };
  const read = [deps.sessionGuard as never];
  const write = [deps.csrfGuard as never, deps.sessionGuard as never];
  const moveFunds = [...write, deps.withdrawalStepUpGuard as never];

  return async (app) => {
    app.get(
      '/markets',
      { preValidation: read, schema: { response: { 200: listMarketsResponseSchema, ...errors } } },
      async (r) => c.markets(r as never),
    );

    app.get(
      '/trading/balances',
      {
        preValidation: read,
        schema: { response: { 200: listTradingBalancesResponseSchema, ...errors } },
      },
      async (r) => c.balances(r as never),
    );

    app.post(
      '/orders',
      {
        preValidation: write,
        schema: { body: placeOrderSchema, response: { 200: orderResponseSchema, ...errors } },
      },
      async (r) => c.place(r as never),
    );

    app.get(
      '/orders',
      {
        preValidation: read,
        schema: {
          querystring: z.object({ market: marketSymbolSchema.optional() }),
          response: { 200: listOrdersResponseSchema, ...errors },
        },
      },
      async (r) => c.list(r as never),
    );

    app.get(
      '/orders/:id',
      {
        preValidation: read,
        schema: { params: idParamSchema, response: { 200: orderResponseSchema, ...errors } },
      },
      async (r) => c.get(r as never),
    );

    app.delete(
      '/orders/:id',
      {
        preValidation: write,
        schema: { params: idParamSchema, response: { 200: orderResponseSchema, ...errors } },
      },
      async (r) => c.cancel(r as never),
    );

    app.delete(
      '/orders',
      {
        preValidation: write,
        schema: {
          querystring: z.object({ market: marketSymbolSchema }),
          response: { 200: cancelAllResponseSchema, ...errors },
        },
      },
      async (r) => c.cancelAll(r as never),
    );

    app.patch(
      '/orders/:id',
      {
        preValidation: write,
        schema: {
          params: idParamSchema,
          body: amendOrderSchema,
          response: { 200: orderResponseSchema, ...errors },
        },
      },
      async (r) => c.amend(r as never),
    );

    app.post(
      '/allocations',
      {
        preValidation: moveFunds,
        schema: {
          body: allocationRequestSchema,
          response: { 200: withdrawalResponseSchema, ...errors },
        },
      },
      async (r) => c.allocate(r as never),
    );

    app.post(
      '/deallocations',
      {
        preValidation: moveFunds,
        schema: {
          body: allocationRequestSchema,
          response: { 200: withdrawalResponseSchema, ...errors },
        },
      },
      async (r) => c.deallocate(r as never),
    );
  };
}
