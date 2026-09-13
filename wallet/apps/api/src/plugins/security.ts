import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';
import { RateLimitError } from '@wallet/errors';

export interface SecurityOptions {
  readonly webOrigin: string;
  readonly cookieSecret: string;
  readonly redis: Redis;
  readonly globalPerMinute: number;
}

const plugin: FastifyPluginAsync<SecurityOptions> = async (app, options) => {
  await app.register(helmet, {
    // The API serves JSON only, never a document, so the useful directives are
    // the ones that stop a browser being tricked into treating a response as
    // something renderable.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  // Exactly one origin, from validated config. Never `origin: true`, never a
  // reflected request origin (prompt_phase1.md rule 150) — reflection turns
  // CORS into a rubber stamp and, with credentials, hands any site a session.
  await app.register(cors, {
    origin: [options.webOrigin],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    /*
     * An ALLOWLIST, so every header the browser sends must be named here.
     *
     * `x-solana-cluster` (ADR-0021) is a custom header, which makes every
     * request a preflighted one — and a header missing from this list fails
     * the preflight, so the browser blocks the request entirely. Nothing
     * server-side notices: every integration test injects into Fastify
     * directly and never crosses an origin, so the suite stays green while the
     * application cannot make a single call. The E2E suite is what catches it.
     */
    allowedHeaders: ['content-type', 'x-correlation-id', 'x-solana-cluster'],
    exposedHeaders: ['x-correlation-id'],
    maxAge: 600,
  });

  await app.register(cookie, { secret: options.cookieSecret });

  // A coarse global limit. The tighter per-IP and per-account limits on auth
  // endpoints are applied per-route (rule 140).
  await app.register(rateLimit, {
    global: true,
    max: options.globalPerMinute,
    timeWindow: '1 minute',
    redis: options.redis,
    // Fastify's own 429 body would bypass the shared error contract.
    errorResponseBuilder: (_request, context) => {
      throw new RateLimitError(Math.ceil(context.ttl / 1000));
    },
  });
};

export const securityPlugin = fp(plugin, { name: 'security' });
