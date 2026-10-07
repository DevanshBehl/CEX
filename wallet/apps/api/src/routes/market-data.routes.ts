import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  bookResponseSchema,
  errorResponseSchema,
  listCandlesQuerySchema,
  listCandlesResponseSchema,
  listFillsQuerySchema,
  listFillsResponseSchema,
  listTradesQuerySchema,
  listTradesResponseSchema,
  marketParamSchema,
  pipelineStatusResponseSchema,
  tickerResponseSchema,
} from '@wallet/types';
import type { MarketDataControllers } from '../controllers/market-data.controller.js';

/**
 * Market data, and the caller's own fills (prompt_phase_s5.md §10).
 *
 * Read-only, every one behind a session: ADR-0037 §1 keeps market data to
 * signed-in users until unauthenticated access is decided for REST and the
 * socket together. Every list is bounded by its schema.
 */
export interface MarketDataRouteDeps {
  readonly controllers: MarketDataControllers;
  /** False when this deployment records no market data: only `/fills` exists. */
  readonly marketData: boolean;
  readonly sessionGuard: (request: never, reply: never) => Promise<void>;
  readonly operatorStepUpGuard: (request: never, reply: never) => Promise<void>;
}

export function createMarketDataRoutes(deps: MarketDataRouteDeps): FastifyPluginAsyncZod {
  const { controllers: c } = deps;
  const errors = {
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    503: errorResponseSchema,
  };
  const read = [deps.sessionGuard as never];

  return async (app) => {
    // The caller's own side of their fills. Exists whenever trading does.
    app.get(
      '/fills',
      {
        preValidation: read,
        schema: {
          querystring: listFillsQuerySchema,
          response: { 200: listFillsResponseSchema, ...errors },
        },
      },
      async (r) => c.fills(r as never),
    );

    // What an operator reads when a market stops settling or recording.
    app.get(
      '/operator/trading/pipeline',
      {
        preValidation: [deps.sessionGuard as never, deps.operatorStepUpGuard as never],
        schema: { response: { 200: pipelineStatusResponseSchema, ...errors } },
      },
      async (r) => c.pipeline(r as never),
    );

    // Refused by absence: with market data off there is no book to serve.
    if (!deps.marketData) return;

    app.get(
      '/markets/:symbol/book',
      {
        preValidation: read,
        schema: { params: marketParamSchema, response: { 200: bookResponseSchema, ...errors } },
      },
      async (r) => c.book(r as never),
    );

    app.get(
      '/markets/:symbol/trades',
      {
        preValidation: read,
        schema: {
          params: marketParamSchema,
          querystring: listTradesQuerySchema,
          response: { 200: listTradesResponseSchema, ...errors },
        },
      },
      async (r) => c.trades(r as never),
    );

    app.get(
      '/markets/:symbol/candles',
      {
        preValidation: read,
        schema: {
          params: marketParamSchema,
          querystring: listCandlesQuerySchema,
          response: { 200: listCandlesResponseSchema, ...errors },
        },
      },
      async (r) => c.candles(r as never),
    );

    app.get(
      '/markets/:symbol/ticker',
      {
        preValidation: read,
        schema: { params: marketParamSchema, response: { 200: tickerResponseSchema, ...errors } },
      },
      async (r) => c.ticker(r as never),
    );
  };
}
