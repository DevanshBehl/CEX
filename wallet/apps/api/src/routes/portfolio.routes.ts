import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorResponseSchema,
  portfolioHistoryResponseSchema,
  portfolioSummaryResponseSchema,
} from '@wallet/types';
import type { PortfolioControllers } from '../controllers/portfolio.controller.js';

export interface PortfolioRoutesDeps {
  readonly controllers: PortfolioControllers;
  readonly sessionGuard: unknown;
}

/**
 * Portfolio valuation (Task 3).
 *
 * Mounted at `/portfolio/...` rather than `/api/v1/portfolio/...`: every other
 * route in this service is unversioned (`/balances`, `/withdrawals`), and two
 * endpoints carrying a version prefix nothing else has would make the surface
 * look like two APIs. Versioning is worth doing — as a decision about the whole
 * surface, not as a special case for the newest pair.
 *
 * Both require a session and neither takes a user id: a portfolio is always
 * the caller's own. There is no route through which one user could value
 * another's holdings.
 */
export function createPortfolioRoutes(deps: PortfolioRoutesDeps): FastifyPluginAsyncZod {
  const c = deps.controllers;

  const errors = {
    400: errorResponseSchema,
    401: errorResponseSchema,
    429: errorResponseSchema,
  };

  return async (app) => {
    app.get(
      '/portfolio/history',
      {
        preValidation: [deps.sessionGuard as never],
        schema: {
          querystring: z.object({
            range: z.enum(['24h', '7d', '30d', 'all']).optional(),
          }),
          response: { 200: portfolioHistoryResponseSchema, ...errors },
        },
      },
      async (request) => c.history(request as never),
    );

    app.get(
      '/portfolio/summary',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { response: { 200: portfolioSummaryResponseSchema, ...errors } },
      },
      async (request) => c.summary(request as never),
    );
  };
}
