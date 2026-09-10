import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { loadApiConfigOrExit, parseEnv, toApiConfig } from '@wallet/config';
import { createPrismaClient, newId } from '@wallet/db';
import { createCapturingLogger, type CapturedLogger } from '@wallet/logger';
import { buildServer } from '../src/server.js';

export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

export interface Harness {
  app: FastifyInstance;
  logs: CapturedLogger;
  cleanup: () => Promise<void>;
  createdUserIds: string[];
}

export async function startHarness(): Promise<Harness> {
  const config = toApiConfig(parseEnv(process.env));
  const logs = createCapturingLogger('trace');
  const db = createPrismaClient({ url: config.database.url });
  const redis = new Redis(config.redis.url, { maxRetriesPerRequest: 3 });

  const app = await buildServer({ config, logger: logs.logger, db, redis });
  await app.ready();

  const createdUserIds: string[] = [];

  return {
    app,
    logs,
    createdUserIds,
    async cleanup() {
      if (createdUserIds.length > 0) {
        await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      await app.close();
      await db.$disconnect();
      redis.disconnect();
    },
  };
}

/**
 * Same-origin headers — the shape a real browser sends.
 *
 * Deliberately no content-type: Fastify sets it when a payload is present, and
 * declaring application/json on a bodyless request makes Fastify reject it as
 * an empty JSON body before any guard runs.
 */
export function browserHeaders(cookie?: string): Record<string, string> {
  return {
    origin: WEB_ORIGIN,
    'sec-fetch-site': 'same-origin',
    ...(cookie !== undefined ? { cookie } : {}),
  };
}

/**
 * Creates a user and a live session directly through the app's own dependency
 * graph, bypassing the WebAuthn ceremony.
 *
 * Justified because the full ceremony needs a real authenticator and is covered
 * by the Playwright E2E suite with a CDP virtual authenticator. What these
 * tests are about is what happens AFTER authentication — guards, step-up,
 * ownership scoping, the error contract.
 */
export async function seedSession(
  harness: Harness,
  options: { steppedUp?: boolean } = {},
): Promise<{ userId: string; sessionId: string; cookie: string; cookieName: string }> {
  const deps = harness.app.appDeps;
  const user = await deps.users.create({ email: `${newId()}@example.test`, displayName: 'Test' });
  harness.createdUserIds.push(user.id);

  const issued = await deps.sessions.issue({
    userId: user.id,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    ...(options.steppedUp === true ? { steppedUp: true } : {}),
  });

  const cookieName = process.env.SESSION_COOKIE_NAME ?? 'wallet_session';
  return {
    userId: user.id,
    sessionId: issued.session.id,
    cookie: `${cookieName}=${issued.token}`,
    cookieName,
  };
}

export { loadApiConfigOrExit };
