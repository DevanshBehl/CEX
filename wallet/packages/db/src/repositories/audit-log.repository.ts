import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';
import type { AuditEntry } from './types.js';

/**
 * Metadata allowlist, mirroring @wallet/logger's (rule 105).
 *
 * Same reasoning, same failure mode: a denylist here would write the first
 * sensitive field someone adds straight into a table that, by design, can never
 * be corrected afterwards. Append-only and "oops" are a bad combination, so
 * this side fails closed too.
 */
const ALLOWED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'credentialType',
  'deviceName',
  'transports',
  'reason',
  'outcome',
  'sessionId',
  'credentialId',
  'revokedCount',
  'signCountStored',
  'signCountReceived',
  'factor',
  'method',
  'route',
  'statusCode',
]);

export interface AuditLogRepository {
  /** Append-only by construction: there is no update or delete method here,
   *  and the database would refuse one anyway (rules 106-108). */
  append(entry: AuditEntry, tx?: Executor): Promise<void>;
  listForUser(
    userId: string,
    limit: number,
    tx?: Executor,
  ): Promise<Array<{ id: string; event: string; createdAt: Date; ip: string | null }>>;
}

export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  if (!metadata) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    if (value === null) {
      out[key] = null;
    } else if (['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value as string | number | boolean;
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = value.join(',');
    }
  }
  return out;
}

export function createAuditLogRepository(db: Executor): AuditLogRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async append(entry, tx) {
      await exec(tx).auditLog.create({
        data: {
          id: newId(),
          event: entry.event,
          metadata: sanitizeMetadata(entry.metadata),
          ...(entry.actorUserId != null ? { actorUserId: entry.actorUserId } : {}),
          ...(entry.targetType != null ? { targetType: entry.targetType } : {}),
          ...(entry.targetId != null ? { targetId: entry.targetId } : {}),
          ...(entry.correlationId != null ? { correlationId: entry.correlationId } : {}),
          ...(entry.ip != null ? { ip: entry.ip } : {}),
        },
      });
    },

    async listForUser(userId, limit, tx) {
      return exec(tx).auditLog.findMany({
        where: { actorUserId: userId },
        select: { id: true, event: true, createdAt: true, ip: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
    },
  };
}
