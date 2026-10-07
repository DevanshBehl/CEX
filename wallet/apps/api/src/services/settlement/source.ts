import type { Redis } from 'ioredis';
import type { EventKey } from '@wallet/db';

/**
 * Where the settlement worker reads engine events from (ADR-0030, ADR-0034 §5).
 *
 * The stream is a TRANSPORT. Position is never taken from it — not a Redis id,
 * not a consumer group's last-delivered id — because neither survives the
 * stream being recreated. Each entry carries its engine event key, and the
 * worker's own offset in PostgreSQL decides what has been applied.
 *
 * The consumer group exists for delivery bookkeeping only: entries are acked
 * after the settlement that covers them commits, so a crash between commit and
 * ack redelivers them, and the offset makes the redelivery a no-op.
 */

export interface StreamEntry {
  /** Redis entry id. For `ack` only — never for position. */
  readonly id: string;
  readonly key: EventKey;
  /** The engine's JSON, undecoded. */
  readonly raw: string;
}

export interface SettlementEventSource {
  /**
   * The next entries for this consumer: first anything delivered to it and
   * never acknowledged (a crash between commit and ack), then new entries.
   *
   * `'reset'` when the stream or the group has vanished — wiped, recreated —
   * which the worker answers with recovery through re-emission.
   */
  read(count: number, blockMs: number): Promise<readonly StreamEntry[] | 'reset'>;
  ack(ids: readonly string[]): Promise<void>;
  /** Release the connection, on shutdown. */
  close?(): Promise<void>;
}

/** An entry whose fields are not `seq`, `idx`, `event` as the engine writes them. */
export class MalformedStreamEntryError extends Error {
  constructor(readonly entryId: string) {
    super('malformed stream entry');
    this.name = 'MalformedStreamEntryError';
  }
}

export function createRedisEventSource(input: {
  readonly redis: Redis;
  readonly stream: string;
  readonly group: string;
  readonly consumer: string;
}): SettlementEventSource {
  const { redis, stream, group, consumer } = input;
  let groupReady = false;
  // Drain this consumer's pending list before asking for new entries.
  let cursor: '0' | '>' = '0';

  async function ensureGroup(): Promise<void> {
    if (groupReady) return;
    try {
      // From the beginning of whatever the stream holds: the offset, not the
      // group, decides what is skipped. The ENGINE creates no group (ADR-0030).
      await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error;
    }
    groupReady = true;
  }

  function parse(id: string, fields: string[]): StreamEntry {
    const map = new Map<string, string>();
    for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
    const seq = map.get('seq');
    const idx = map.get('idx');
    const raw = map.get('event');
    if (!seq || !/^\d+$/.test(seq) || !idx || !/^\d+$/.test(idx) || raw === undefined) {
      throw new MalformedStreamEntryError(id);
    }
    return { id, key: { seq: BigInt(seq), idx: Number(idx) }, raw };
  }

  return {
    async read(count, blockMs) {
      await ensureGroup();
      for (;;) {
        let reply: [string, [string, string[]][]][] | null;
        try {
          const args: (string | number)[] = ['GROUP', group, consumer, 'COUNT', count];
          if (cursor === '>') args.push('BLOCK', blockMs);
          args.push('STREAMS', stream, cursor);
          reply = (await redis.call('XREADGROUP', ...args)) as typeof reply;
        } catch (error) {
          if (error instanceof Error && error.message.includes('NOGROUP')) {
            // The stream was deleted or recreated under us. Everything since the
            // offset must come from re-emission.
            groupReady = false;
            cursor = '0';
            return 'reset';
          }
          throw error;
        }
        const entries = reply?.[0]?.[1] ?? [];
        if (cursor === '0' && entries.length === 0) {
          // Nothing left pending. That says nothing about NEW entries, so ask
          // for those now: an empty read tells the worker the stream is idle,
          // and it would go to the engine for what is sitting right here.
          cursor = '>';
          continue;
        }
        // A pending entry whose payload was trimmed comes back with null fields.
        return entries
          .filter(([, fields]) => fields !== null)
          .map(([id, fields]) => parse(id, fields));
      }
    },

    async ack(ids) {
      if (ids.length === 0) return;
      await redis.xack(stream, group, ...ids);
    },

    async close() {
      // The connection is this source's own (see server.ts), never shared.
      redis.disconnect();
    },
  };
}
