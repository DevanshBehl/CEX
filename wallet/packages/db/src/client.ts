import { PrismaClient } from '@prisma/client';

export type { PrismaClient };

export interface DbOptions {
  /** Connection string. Supplied by the caller — this package never reads the
   *  environment (prompt_phase1.md rule 56). */
  readonly url: string;
  readonly log?: boolean;
}

/**
 * Prisma is confined to this package (rule 89). Everything outside it talks to
 * repositories, so swapping the ORM — or putting a ledger's hand-written SQL
 * behind the same interfaces in Phase 2 — touches one directory.
 */
export function createPrismaClient(options: DbOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: options.url } },
    // Query logging is off by default: parameters would carry token hashes and
    // credential bytes straight past the logger's allowlist (rules 73-77).
    log: options.log ? ['warn', 'error'] : ['error'],
  });
}
