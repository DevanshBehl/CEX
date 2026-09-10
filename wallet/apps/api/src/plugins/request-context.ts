import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { runWithContext, type Logger } from '@wallet/logger';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    log2: Logger;
  }
}

const HEADER = 'x-correlation-id';
/** Accept an inbound id only if it looks like one — an unbounded header value
 *  would end up in every log line and every audit row. */
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface RequestContextOptions {
  readonly logger: Logger;
}

/**
 * MUST be registered first (prompt_phase1.md rule 148).
 *
 * Everything downstream — the error handler, the auth guard, every service —
 * logs through the ambient context this establishes. Register it second and
 * the lines emitted before it have no correlation id, which is exactly the
 * window where the interesting failures happen.
 */
const plugin: FastifyPluginAsync<RequestContextOptions> = async (app, options) => {
  app.decorateRequest('correlationId', '');
  app.decorateRequest('log2', null as unknown as Logger);

  app.addHook('onRequest', (request, reply, done) => {
    const inbound = request.headers[HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const correlationId =
      candidate !== undefined && SAFE_ID.test(candidate) ? candidate : randomUUID();

    request.correlationId = correlationId;
    request.log2 = options.logger;

    // Returned on every response, success or failure, so a user reporting a
    // problem can quote something that ties to the server logs (rules 72, 167).
    void reply.header(HEADER, correlationId);

    runWithContext(
      {
        correlationId,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
      },
      done,
    );
  });
};

export const requestContextPlugin = fp(plugin, { name: 'request-context' });
