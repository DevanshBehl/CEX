import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { liveResponseSchema, readyResponseSchema } from '@wallet/types';
import type { HealthService } from '../services/health.service.js';

export function createHealthRoutes(health: HealthService): FastifyPluginAsyncZod {
  return async (app) => {
    /**
     * Liveness must not touch the database (rule 151). A liveness probe that
     * fails when Postgres is briefly unreachable causes an orchestrator to
     * restart a perfectly healthy process — turning a dependency blip into an
     * outage.
     */
    app.get(
      '/health/live',
      {
        config: { rateLimit: false },
        schema: { response: { 200: liveResponseSchema } },
      },
      async () => ({ status: 'ok' as const, uptimeSeconds: Math.floor(process.uptime()) }),
    );

    app.get(
      '/health/ready',
      {
        config: { rateLimit: false },
        schema: { response: { 200: readyResponseSchema, 503: readyResponseSchema } },
      },
      async (_request, reply) => {
        const result = await health.ready();
        // 503 when anything is down, so a load balancer stops sending traffic
        // (rule 154).
        return reply.status(result.status === 'ok' ? 200 : 503).send(result);
      },
    );
  };
}
