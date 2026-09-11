import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DeadLetterQueue, JobQueue } from '../observability/dead-letter.js';
import type { Metrics } from '../observability/metrics.js';

/**
 * Operator-facing operations endpoints (prompt_phase4.md rules 146, 153, 155).
 *
 * WHY THESE ARE BEHIND THE OPERATOR GUARD
 *
 * `/metrics` looks harmless and is not. Queue depths, failure counts and
 * withdrawal-state transition rates describe the platform's internal condition,
 * and an attacker probing for "is the signer down" or "is the hot wallet
 * rebalancing" gets a useful answer from an unauthenticated scrape. The
 * conventional deployment answer is to bind it to a private interface; this
 * application cannot assume one exists, so it authenticates instead.
 *
 * The DLQ retry endpoint is a financial action — it replays a job against the
 * chain — so it carries the same step-up requirement as approving a withdrawal.
 */

const QUEUES = [
  'withdrawal_sign',
  'withdrawal_broadcast',
  'withdrawal_expiry',
  'sweep',
] as const satisfies readonly JobQueue[];

const deadLetterSchema = z.object({
  id: z.string(),
  queue: z.enum(QUEUES),
  reference: z.string(),
  attempts: z.number(),
  failedAt: z.string(),
  errorName: z.string(),
  correlationId: z.string(),
  retriedAt: z.string().nullable(),
  /**
   * The idempotency key is NOT returned. It is an internal correlation value,
   * and an operator does not need to see it to press retry — the retry replays
   * it server-side, which is the entire point (rule 154).
   */
});

export interface OperationsRoutesDeps {
  readonly metrics: Metrics;
  readonly deadLetters: DeadLetterQueue;
  readonly sessionGuard: (request: never, reply: never) => Promise<void>;
  readonly operatorStepUpGuard: (request: never, reply: never) => Promise<void>;
  readonly retryHandler: (queue: JobQueue, reference: string) => Promise<void>;
}

export function createOperationsRoutes(deps: OperationsRoutesDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/operator/metrics',
      {
        config: { rateLimit: false },
        preValidation: [deps.sessionGuard as never, deps.operatorStepUpGuard as never],
      },
      async (_request, reply) =>
        // Prometheus text format, not JSON — this is scraped, not read.
        reply
          .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
          .send(deps.metrics.render()),
    );

    app.get(
      '/operator/dead-letters',
      {
        preValidation: [deps.sessionGuard as never, deps.operatorStepUpGuard as never],
        schema: {
          querystring: z.object({ queue: z.enum(QUEUES).optional() }),
          response: { 200: z.object({ jobs: z.array(deadLetterSchema) }) },
        },
      },
      async (request) => {
        const { queue } = request.query;
        return {
          jobs: deps.deadLetters.list(queue).map((job) => ({
            id: job.id,
            queue: job.queue,
            reference: job.reference,
            attempts: job.attempts,
            failedAt: job.failedAt.toISOString(),
            errorName: job.errorName,
            correlationId: job.correlationId,
            retriedAt: job.retriedAt?.toISOString() ?? null,
          })),
        };
      },
    );

    app.post(
      '/operator/dead-letters/:id/retry',
      {
        preValidation: [deps.sessionGuard as never, deps.operatorStepUpGuard as never],
        schema: {
          params: z.object({ id: z.string() }),
          response: {
            200: z.object({ outcome: z.enum(['retried', 'already_retried', 'failed']) }),
            404: z.object({ outcome: z.literal('not_found') }),
          },
        },
      },
      async (request, reply) => {
        const outcome = await deps.deadLetters.retry(request.params.id, async (job) => {
          await deps.retryHandler(job.queue, job.reference);
        });

        if (outcome === 'not_found') {
          return reply.status(404).send({ outcome });
        }
        return reply.send({ outcome });
      },
    );
  };
}
