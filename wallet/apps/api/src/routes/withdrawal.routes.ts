import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  errorResponseSchema,
  idParamSchema,
  listReviewQueueResponseSchema,
  listWithdrawalsResponseSchema,
  operatorDecisionSchema,
  requestWithdrawalSchema,
  withdrawalResponseSchema,
} from '@wallet/types';
import type { WithdrawalControllers } from '../controllers/withdrawal.controller.js';

export interface WithdrawalRouteDeps {
  readonly controllers: WithdrawalControllers;
  readonly sessionGuard: (request: never, reply: never) => Promise<void>;
  readonly csrfGuard: (request: never, reply: never) => Promise<void>;
  /** Freshness tiered by value (ADR-0011). */
  readonly withdrawalStepUpGuard: (request: never, reply: never) => Promise<void>;
  readonly operatorStepUpGuard: (request: never, reply: never) => Promise<void>;
  readonly rateLimit: { max: number; timeWindow: string };
}

export function createWithdrawalRoutes(deps: WithdrawalRouteDeps): FastifyPluginAsyncZod {
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
    /**
     * Submit a withdrawal.
     *
     * Guards run at `preValidation`, before schema validation — the Phase 1
     * lesson (rule 66). Ordered: origin, then session, then step-up, so an
     * anonymous caller is refused before the server describes the endpoint.
     */
    app.post(
      '/withdrawals',
      {
        config: { rateLimit: deps.rateLimit },
        preValidation: [
          deps.csrfGuard as never,
          deps.sessionGuard as never,
          deps.withdrawalStepUpGuard as never,
        ],
        schema: {
          body: requestWithdrawalSchema,
          response: { 200: withdrawalResponseSchema, ...errors },
        },
      },
      async (request) => c.request(request as never),
    );

    app.get(
      '/withdrawals',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { response: { 200: listWithdrawalsResponseSchema, ...errors } },
      },
      async (request) => c.list(request as never),
    );

    app.get(
      '/withdrawals/:id',
      {
        preValidation: [deps.sessionGuard as never],
        schema: { params: idParamSchema, response: { 200: withdrawalResponseSchema, ...errors } },
      },
      async (request) => c.get(request as never),
    );

    // -----------------------------------------------------------------------
    // Operator queue (rules 160-162)
    // -----------------------------------------------------------------------
    app.get(
      '/operator/review-queue',
      {
        preValidation: [deps.sessionGuard as never, deps.operatorStepUpGuard as never],
        schema: { response: { 200: listReviewQueueResponseSchema, ...errors } },
      },
      async (request) => c.reviewQueue(request as never),
    );

    app.post(
      '/operator/withdrawals/:id/approve',
      {
        preValidation: [
          deps.csrfGuard as never,
          deps.sessionGuard as never,
          deps.operatorStepUpGuard as never,
        ],
        schema: {
          params: idParamSchema,
          body: operatorDecisionSchema,
          response: { 200: withdrawalResponseSchema, ...errors },
        },
      },
      async (request) => c.approve(request as never),
    );

    app.post(
      '/operator/withdrawals/:id/reject',
      {
        preValidation: [
          deps.csrfGuard as never,
          deps.sessionGuard as never,
          deps.operatorStepUpGuard as never,
        ],
        schema: {
          params: idParamSchema,
          body: operatorDecisionSchema,
          response: { 200: withdrawalResponseSchema, ...errors },
        },
      },
      async (request) => c.reject(request as never),
    );
  };
}
