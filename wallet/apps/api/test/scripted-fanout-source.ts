import { keyByPosition } from '../src/services/settlement/events.js';
import type { FanoutEntry, FanoutSource } from '../src/services/market-data/fanout.js';
import { stringifyEngineJson } from '../src/services/trading/engine-client.js';
import type { FakeEngine } from './fake-engine.js';

/**
 * The engine's stream as the LIVE fan-out reads it (ADR-0036 §§1-2): plain
 * entries in publication order, the last entry of each sequence carrying
 * `levels`, and no acknowledgement.
 *
 * A test can lose entries, or publish a sequence whose last entry has no
 * `levels` — the two things that must make a mirror stop vouching for itself.
 */
export interface ScriptedFanoutSource extends FanoutSource {
  /** `XADD` everything the engine has journaled and not yet published. */
  publish(): Promise<void>;
  /** Lose entries that have not been read yet. */
  drop(lost: (entry: FanoutEntry) => boolean): void;
  /** Publish the next sequences WITHOUT their `levels` field. */
  withholdLevels(on: boolean): void;
  /** Entries published and not yet read. */
  unread(): number;
}

export function createScriptedFanoutSource(engine: FakeEngine): ScriptedFanoutSource {
  let stream: FanoutEntry[] = [];
  let position = 0;
  let taken = 0;
  let withhold = false;

  return {
    async publish() {
      const raws = (await engine.rawEvents(0n, Number.MAX_SAFE_INTEGER)) ?? [];
      const keyed = keyByPosition(raws);
      for (let i = taken; i < keyed.length; i += 1) {
        const item = keyed[i]!;
        const lastOfSeq = keyed[i + 1]?.key.seq !== item.key.seq;
        const changes = engine.levelsOf(item.key.seq) ?? [];
        stream.push({
          seq: item.key.seq,
          idx: item.key.idx,
          raw: stringifyEngineJson(item.raw),
          levels:
            lastOfSeq && !withhold
              ? stringifyEngineJson(
                  changes.map((change) => ({
                    side: change.side,
                    price: change.price,
                    qty: change.qty.toString(),
                  })),
                )
              : null,
        });
      }
      taken = keyed.length;
    },

    drop(lost) {
      const read = stream.slice(0, position);
      stream = [...read, ...stream.slice(position).filter((entry) => !lost(entry))];
    },

    withholdLevels(on) {
      withhold = on;
    },

    unread: () => stream.length - position,

    async seekToEnd() {
      position = stream.length;
    },

    async read(count) {
      const entries = stream.slice(position, position + count);
      position += entries.length;
      return entries;
    },
  };
}
