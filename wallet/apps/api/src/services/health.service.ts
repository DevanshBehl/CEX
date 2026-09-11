import type { PrismaClient } from '@wallet/db';
import type { Redis } from 'ioredis';
import type { DependencyStatus, ReadyResponse } from '@wallet/types';

export interface HealthService {
  ready(): Promise<ReadyResponse>;
}

/**
 * Each dependency reports on its own (prompt_phase1.md rule 152).
 *
 * The array shape is deliberate: Phase 4 adds Solana RPC and the MPC service as
 * two more entries and the contract does not change (rule 153). A single
 * `{healthy: boolean}` would have to be redesigned the first time something
 * else needed checking, and it never tells an operator WHICH thing is down.
 */
export interface HealthProbe {
  readonly name: string;
  readonly check: () => Promise<boolean>;
}

export function createHealthService(
  db: PrismaClient,
  redis: Redis,
  extra: readonly HealthProbe[] = [],
): HealthService {
  return {
    async ready() {
      const dependencies = await Promise.all([
        probe('postgres', async () => {
          await db.$queryRawUnsafe('SELECT 1');
        }),
        probe('redis', async () => {
          await redis.ping();
        }),
        // Phase 4 adds the MPC service here (master-prompt rule 170). The array
        // shape was designed for exactly this in Phase 1 — the contract does
        // not change to accommodate it.
        ...extra.map((entry) =>
          probe(entry.name, async () => {
            if (!(await entry.check())) throw new Error('unhealthy');
          }),
        ),
      ]);

      const status: ReadyResponse['status'] = dependencies.every((d) => d.status === 'up')
        ? 'ok'
        : dependencies.some((d) => d.status === 'up')
          ? 'degraded'
          : 'down';

      return { status, dependencies };
    },
  };
}

async function probe(name: string, check: () => Promise<void>): Promise<DependencyStatus> {
  const started = Date.now();
  try {
    await check();
    return { name, status: 'up', latencyMs: Date.now() - started };
  } catch {
    // A driver message would carry the connection string. The operator learns
    // WHICH dependency is down from `name`; WHY belongs in the logs (rule 152).
    return { name, status: 'down', latencyMs: Date.now() - started, detail: 'probe failed' };
  }
}
