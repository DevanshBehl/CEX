import type {
  EngineBook,
  EngineClient,
  EngineEvent,
  EngineHealth,
  EngineResult,
  LookupResult,
  PlaceCommand,
} from '../src/services/trading/engine-client.js';

/**
 * A matching engine whose behaviour a test chooses.
 *
 * It keeps a real JOURNAL — every command it "accepted" is recorded by
 * sequence, with the events it produced — so `lookup` and `events` answer the
 * way the real engine does. That matters because the paths under test are the
 * ones where the gateway and the engine disagree about what happened: an
 * ambiguous reply for a command that WAS applied, or a lookup that says
 * `rebuilding`. A fake with no memory could not express either.
 */
export type PlaceBehaviour =
  /** Rests the order. */
  | 'accept'
  /** Journals it, then answers 503 — applied, but the caller cannot know. */
  | 'ambiguous_applied'
  /** Answers 503 WITHOUT journaling — never applied. */
  | 'ambiguous_lost'
  /** A business rejection (200 + Rejected). */
  | 'reject'
  /** The transport refused it (401): never reached the book. */
  | 'refuse'
  /** Fills it in full against a phantom maker. */
  | 'fill'
  /** IOC that finds nothing and expires. */
  | 'expire';

export interface FakeEngine extends EngineClient {
  behaviour: PlaceBehaviour;
  lookupOverride: LookupResult['outcome'] | null;
  referencePrice: bigint | null;
  health_: EngineHealth;
  readonly placed: PlaceCommand[];
  /** Simulate a fill of `qty` against a resting order, from another taker. */
  fillResting(orderId: string, qty: bigint): void;
}

export function createFakeEngine(input: {
  market: string;
  marketId: string;
  tickSize: bigint;
  lotSize: bigint;
  minNotional: bigint;
  collarBps: number;
}): FakeEngine {
  let seq = 0n;
  const journal = new Map<string, { seq: bigint; events: EngineEvent[] }>();
  const resting = new Map<string, { qty: bigint; remaining: bigint; command: PlaceCommand }>();
  const allEvents: EngineEvent[] = [];

  function record(orderId: string, events: EngineEvent[]): bigint {
    seq += 1n;
    const stamped = events.map((e) => ({ ...e, seq }) as EngineEvent);
    journal.set(orderId, { seq, events: stamped });
    allEvents.push(...stamped);
    return seq;
  }

  const engine: FakeEngine = {
    market: input.market,
    behaviour: 'accept',
    lookupOverride: null,
    referencePrice: 150_000_000n,
    placed: [],
    health_: {
      market: input.marketId,
      status: 'open',
      tickSize: input.tickSize,
      lotSize: input.lotSize,
      minNotional: input.minNotional,
      collarBps: input.collarBps,
      lastSeq: 0n,
    },

    async place(command): Promise<EngineResult> {
      engine.placed.push(command);
      const id = command.orderId;
      switch (engine.behaviour) {
        case 'refuse':
          return { kind: 'refused', status: 401, error: 'signature_rejected' };
        case 'ambiguous_lost':
          return { kind: 'ambiguous', cause: 'engine_503' };
        case 'ambiguous_applied': {
          resting.set(id, { qty: command.qty, remaining: command.qty, command });
          record(id, [{ kind: 'accepted', seq: 0n, orderId: id, restingQty: command.qty }]);
          return { kind: 'ambiguous', cause: 'engine_503' };
        }
        case 'reject': {
          const events: EngineEvent[] = [
            { kind: 'rejected', seq: 0n, orderId: id, reason: 'OUTSIDE_COLLAR' },
          ];
          const s = record(id, events);
          return { kind: 'ok', seq: s, events: journal.get(id)!.events };
        }
        case 'expire': {
          record(id, [{ kind: 'expired', seq: 0n, orderId: id, remainingQty: command.qty }]);
          const entry = journal.get(id)!;
          return { kind: 'ok', seq: entry.seq, events: entry.events };
        }
        case 'fill': {
          record(id, [
            {
              kind: 'fill',
              seq: 0n,
              fillId: `x:0`,
              takerOrderId: id,
              makerOrderId: 'phantom-maker',
              takerSide: command.side,
              price: command.price ?? 0n,
              qty: command.qty,
            },
            { kind: 'accepted', seq: 0n, orderId: id, restingQty: 0n },
          ]);
          const entry = journal.get(id)!;
          return { kind: 'ok', seq: entry.seq, events: entry.events };
        }
        case 'accept':
        default: {
          resting.set(id, { qty: command.qty, remaining: command.qty, command });
          record(id, [{ kind: 'accepted', seq: 0n, orderId: id, restingQty: command.qty }]);
          const entry = journal.get(id)!;
          return { kind: 'ok', seq: entry.seq, events: entry.events };
        }
      }
    },

    async cancel(orderId): Promise<EngineResult> {
      const order = resting.get(orderId);
      seq += 1n;
      if (!order) {
        const events: EngineEvent[] = [{ kind: 'rejected', seq, orderId, reason: 'UNKNOWN_ORDER' }];
        allEvents.push(...events);
        return { kind: 'ok', seq, events };
      }
      resting.delete(orderId);
      const events: EngineEvent[] = [
        { kind: 'cancelled', seq, orderId, remainingQty: order.remaining },
      ];
      allEvents.push(...events);
      return { kind: 'ok', seq, events };
    },

    async amend(amend): Promise<EngineResult> {
      const order = resting.get(amend.orderId);
      seq += 1n;
      if (!order) {
        const events: EngineEvent[] = [
          { kind: 'rejected', seq, orderId: amend.orderId, reason: 'UNKNOWN_ORDER' },
        ];
        allEvents.push(...events);
        return { kind: 'ok', seq, events };
      }
      resting.delete(amend.orderId);
      resting.set(amend.newOrderId, {
        qty: amend.qty,
        remaining: amend.qty,
        command: {
          ...order.command,
          orderId: amend.newOrderId,
          price: amend.price,
          qty: amend.qty,
        },
      });
      const events: EngineEvent[] = [
        { kind: 'cancelled', seq, orderId: amend.orderId, remainingQty: order.remaining },
        { kind: 'accepted', seq, orderId: amend.newOrderId, restingQty: amend.qty },
      ];
      journal.set(amend.newOrderId, { seq, events });
      allEvents.push(...events);
      return { kind: 'ok', seq, events };
    },

    async lookup(clientOrderId): Promise<LookupResult> {
      if (engine.lookupOverride === 'rebuilding') return { outcome: 'rebuilding' };
      if (engine.lookupOverride === 'unreachable') return { outcome: 'unreachable', cause: 'test' };
      const entry = journal.get(clientOrderId);
      return entry
        ? { outcome: 'seen', seq: entry.seq, orderId: clientOrderId }
        : { outcome: 'never_seen' };
    },

    async events(afterSeq, limit) {
      return allEvents.filter((e) => e.seq > afterSeq).slice(0, limit);
    },

    async book(): Promise<EngineBook> {
      return { seq, referencePrice: engine.referencePrice, bestBid: null, bestAsk: null };
    },

    async health() {
      return { ...engine.health_, lastSeq: seq };
    },

    fillResting(orderId, qty) {
      const order = resting.get(orderId);
      if (!order) throw new Error(`no resting order ${orderId}`);
      order.remaining -= qty;
      if (order.remaining <= 0n) resting.delete(orderId);
    },
  };
  return engine;
}
