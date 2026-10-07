import type { EventKey } from '@wallet/db';
import { keyByPosition } from '../src/services/settlement/events.js';
import type { SettlementEventSource, StreamEntry } from '../src/services/settlement/source.js';
import { stringifyEngineJson } from '../src/services/trading/engine-client.js';
import type { FakeEngine } from './fake-engine.js';

/**
 * An engine event stream a test controls (ADR-0034 §5).
 *
 * It behaves as a Redis stream with one consumer group does: an entry stays
 * pending until it is acknowledged, and is delivered again until then. On top
 * of that a test can do what production only does by accident — deliver
 * everything twice, lose entries from the middle, lose the whole stream, or
 * die between the commit and the ack.
 *
 * Entries carry the keys the ENGINE would have published: the fake engine's
 * journal, keyed by position exactly as `egress.rs` keys it.
 */
export interface ScriptedSource extends SettlementEventSource {
  /** `XADD` everything the engine has journaled and not yet published. */
  publish(): Promise<void>;
  /** Put every entry ever published back on the stream: duplicate delivery. */
  republish(): void;
  /** Lose entries from the stream, as a trim or a failed publish would. */
  drop(lost: (entry: StreamEntry) => boolean): void;
  /** The stream is deleted. The next read reports it, once. */
  wipe(): void;
  /** Append an entry the engine never journaled — an unreadable one, say. */
  push(key: EventKey, raw: string): void;
  /** The process dies after the commit and before the next `XACK`. */
  failNextAck(): void;
  /** Entries delivered or deliverable and not yet acknowledged. */
  pending(): number;
  /** Every entry this stream ever carried, in order. */
  published(): readonly StreamEntry[];
}

export function createScriptedSource(engine: FakeEngine): ScriptedSource {
  let queue: StreamEntry[] = [];
  const everything: StreamEntry[] = [];
  let taken = 0;
  let ids = 0;
  let reset = false;
  let ackFails = false;

  const add = (key: EventKey, raw: string): void => {
    ids += 1;
    const entry = { id: `${String(ids)}-0`, key, raw };
    queue.push(entry);
    everything.push(entry);
  };

  return {
    async publish() {
      const raws = (await engine.rawEvents(0n, Number.MAX_SAFE_INTEGER)) ?? [];
      for (const item of keyByPosition(raws).slice(taken)) {
        add(item.key, stringifyEngineJson(item.raw));
      }
      taken = raws.length;
    },

    republish() {
      for (const entry of [...everything]) add(entry.key, entry.raw);
    },

    drop(lost) {
      queue = queue.filter((entry) => !lost(entry));
    },

    wipe() {
      queue = [];
      reset = true;
    },

    push(key, raw) {
      add(key, raw);
    },

    failNextAck() {
      ackFails = true;
    },

    pending: () => queue.length,
    published: () => everything,

    async read(count) {
      if (reset) {
        reset = false;
        return 'reset';
      }
      return queue.slice(0, count);
    },

    async ack(done) {
      if (ackFails) {
        ackFails = false;
        throw new Error('process died before XACK');
      }
      const acked = new Set(done);
      queue = queue.filter((entry) => !acked.has(entry.id));
    },
  };
}
