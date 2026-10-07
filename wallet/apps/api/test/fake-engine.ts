import type {
  EngineBook,
  EngineClient,
  EngineDepth,
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
  | 'expire'
  /**
   * Matches against what rests, price-time priority, at the maker's price —
   * the events a real engine emits: fills first, then the taker's disposition.
   * Settlement tests use this; the fills name real orders with real holds.
   */
  | 'match'
  /** Matches and journals, then answers 503: the gateway never sees the fills. */
  | 'match_ambiguous';

export interface FakeEngine extends EngineClient {
  behaviour: PlaceBehaviour;
  lookupOverride: LookupResult['outcome'] | null;
  referencePrice: bigint | null;
  health_: EngineHealth;
  readonly placed: PlaceCommand[];
  /** Stamped onto fills as `timestamp_ms`: the command's signed time (ADR-0031). */
  clockMs: bigint;
  /** Simulate a fill of `qty` against a resting order, from another taker. */
  fillResting(orderId: string, qty: bigint): void;
  /** Journal a market status change: one event, no order. */
  changeStatus(): void;
  /** Journal one command's events exactly as given — for events no honest book emits. */
  journalEvents(events: readonly EngineEvent[]): bigint;
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
  /** `timestamp_ms` per fill id, fixed when the fill is journaled. */
  const fillTimes = new Map<string, bigint>();

  function record(orderId: string, events: EngineEvent[]): bigint {
    seq += 1n;
    const stamped = events.map((e) => ({ ...e, seq }) as EngineEvent);
    journal.set(orderId, { seq, events: stamped });
    allEvents.push(...stamped);
    return seq;
  }

  /** Cross `command` against the book. Returns its events and what is left of it. */
  function match(command: PlaceCommand): EngineEvent[] {
    const limit = command.price;
    const crossing = [...resting.entries()]
      .filter(([, maker]) => {
        const price = maker.command.price;
        if (maker.command.side === command.side || price === null || limit === null) return false;
        return command.side === 'buy' ? price <= limit : price >= limit;
      })
      // Best price first; the Map's insertion order breaks ties (time priority).
      .sort(([, a], [, b]) => {
        const diff = a.command.price! - b.command.price!;
        const better = command.side === 'buy' ? diff : -diff;
        return better < 0n ? -1 : better > 0n ? 1 : 0;
      });

    const events: EngineEvent[] = [];
    let remaining = command.qty;
    for (const [makerId, maker] of crossing) {
      if (remaining === 0n) break;
      const traded = remaining < maker.remaining ? remaining : maker.remaining;
      // `seq:k`, k counting fills — as the engine names them.
      const fillId = `${(seq + 1n).toString()}:${String(events.length)}`;
      fillTimes.set(fillId, engine.clockMs);
      events.push({
        kind: 'fill',
        seq: 0n,
        fillId,
        takerOrderId: command.orderId,
        makerOrderId: makerId,
        takerSide: command.side,
        price: maker.command.price!,
        qty: traded,
      });
      maker.remaining -= traded;
      if (maker.remaining === 0n) resting.delete(makerId);
      remaining -= traded;
    }
    if (remaining > 0n && command.timeInForce !== 'GTC') {
      events.push({ kind: 'expired', seq: 0n, orderId: command.orderId, remainingQty: remaining });
    } else {
      if (remaining > 0n) resting.set(command.orderId, { qty: command.qty, remaining, command });
      events.push({ kind: 'accepted', seq: 0n, orderId: command.orderId, restingQty: remaining });
    }
    return events;
  }

  const engine: FakeEngine = {
    market: input.market,
    behaviour: 'accept',
    lookupOverride: null,
    referencePrice: 150_000_000n,
    clockMs: 1_700_000_000_000n,
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
        case 'match_ambiguous': {
          record(id, match(command));
          return { kind: 'ambiguous', cause: 'engine_503' };
        }
        case 'match': {
          record(id, match(command));
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
      // Pages end at a sequence boundary, as the real engine's do.
      return wholeSequences(
        allEvents.filter((e) => e.seq > afterSeq),
        limit,
      );
    },

    async rawEvents(afterSeq, limit) {
      // The engine's own wire shape, so settlement's strict decoder reads it.
      // Pages end at a sequence boundary, as the real engine's do.
      return wholeSequences(
        allEvents.filter((e) => e.seq > afterSeq),
        limit,
      ).map((event) =>
        encodeEngineEvent(event, event.kind === 'fill' ? fillTimes.get(event.fillId) : undefined),
      );
    },

    async depth(): Promise<EngineDepth> {
      const levels = (side: 'buy' | 'sell') => {
        const byPrice = new Map<bigint, bigint>();
        for (const { remaining, command } of resting.values()) {
          if (command.side !== side || command.price === null) continue;
          byPrice.set(command.price, (byPrice.get(command.price) ?? 0n) + remaining);
        }
        return [...byPrice].map(([price, qty]) => ({ price, qty }));
      };
      return { seq, bids: levels('buy'), asks: levels('sell') };
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

    changeStatus() {
      seq += 1n;
      allEvents.push({ kind: 'status_changed', seq });
    },

    journalEvents(events) {
      seq += 1n;
      for (const event of events) {
        if (event.kind === 'fill') fillTimes.set(event.fillId, engine.clockMs);
        allEvents.push({ ...event, seq } as EngineEvent);
      }
      return seq;
    },
  };
  return engine;
}

/** At least `limit` events — more if needed to finish the sequence it fell inside. */
function wholeSequences(events: readonly EngineEvent[], limit: number): EngineEvent[] {
  const page: EngineEvent[] = [];
  for (const event of events) {
    if (page.length >= limit && page[page.length - 1]!.seq !== event.seq) break;
    page.push(event);
  }
  return page;
}

/** An event in the engine's serde shape: `{"Variant": {...snake_case}}`. */
export function encodeEngineEvent(event: EngineEvent, timestampMs = 1_700_000_000_000n): unknown {
  switch (event.kind) {
    case 'accepted':
      return {
        Accepted: { seq: event.seq, order_id: event.orderId, resting_qty: event.restingQty },
      };
    case 'rejected':
      return { Rejected: { seq: event.seq, order_id: event.orderId, reason: event.reason } };
    case 'cancelled':
      return {
        Cancelled: { seq: event.seq, order_id: event.orderId, remaining_qty: event.remainingQty },
      };
    case 'expired':
      return {
        Expired: { seq: event.seq, order_id: event.orderId, remaining_qty: event.remainingQty },
      };
    case 'status_changed':
      return { StatusChanged: { seq: event.seq, previous: 'open', current: 'halted' } };
    case 'fill':
      return {
        Fill: {
          fill_id: event.fillId,
          seq: event.seq,
          taker_order_id: event.takerOrderId,
          maker_order_id: event.makerOrderId,
          taker_side: event.takerSide,
          price: event.price,
          qty: event.qty,
          timestamp_ms: timestampMs,
          maker_fee: null,
          taker_fee: null,
        },
      };
  }
}
