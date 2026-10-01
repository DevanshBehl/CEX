import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * A client for one matching engine (ADR-0030, ADR-0031).
 *
 * # Three outcomes, never two
 *
 * Every mutating call returns `ok`, `refused`, or **`ambiguous`**. The third is
 * the one that matters. A 503 from the engine means its events did not reach
 * the stream — but the command IS journaled and the book HAS mutated. A timeout
 * or a dropped connection after the request left is the same: the engine may
 * have acted. Either way the caller lost certainty, not the order, and must
 * resolve it through `lookup` rather than by retrying blind.
 *
 * # One fresh request id per attempt
 *
 * The engine refuses a reused request id inside its tolerance window with a 409
 * (ADR-0031). So every call mints a new one. The durable idempotency boundary is
 * the gateway's `UNIQUE(user_id, client_order_id)`, not this id.
 */

export type EngineSide = 'buy' | 'sell';
export type EngineStatus = 'pre_open' | 'open' | 'post_only' | 'halted';

export type EngineEvent =
  | {
      readonly kind: 'accepted';
      readonly seq: bigint;
      readonly orderId: string;
      readonly restingQty: bigint;
    }
  | {
      readonly kind: 'rejected';
      readonly seq: bigint;
      readonly orderId: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'fill';
      readonly seq: bigint;
      readonly fillId: string;
      readonly takerOrderId: string;
      readonly makerOrderId: string;
      readonly takerSide: EngineSide;
      readonly price: bigint;
      readonly qty: bigint;
    }
  | {
      readonly kind: 'cancelled';
      readonly seq: bigint;
      readonly orderId: string;
      readonly remainingQty: bigint;
    }
  | {
      readonly kind: 'expired';
      readonly seq: bigint;
      readonly orderId: string;
      readonly remainingQty: bigint;
    }
  | { readonly kind: 'status_changed'; readonly seq: bigint };

export type EngineResult =
  | { readonly kind: 'ok'; readonly seq: bigint; readonly events: readonly EngineEvent[] }
  /** The request never reached the book: bad auth, malformed, unknown route. */
  | { readonly kind: 'refused'; readonly status: number; readonly error: string }
  /** The engine MAY have acted. Resolve with `lookup`, never by retrying. */
  | { readonly kind: 'ambiguous'; readonly cause: string };

export type LookupResult =
  | { readonly outcome: 'never_seen' }
  | { readonly outcome: 'seen'; readonly seq: bigint; readonly orderId: string }
  /** Its own answer. Reading it as `never_seen` releases a hold on a live order. */
  | { readonly outcome: 'rebuilding' }
  | { readonly outcome: 'unreachable'; readonly cause: string };

export interface EngineHealth {
  readonly market: string;
  readonly status: EngineStatus;
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minNotional: bigint;
  readonly collarBps: number;
  readonly lastSeq: bigint;
}

export interface EngineBook {
  readonly seq: bigint;
  readonly referencePrice: bigint | null;
  readonly bestBid: bigint | null;
  readonly bestAsk: bigint | null;
}

export interface PlaceCommand {
  readonly orderId: string;
  readonly side: EngineSide;
  readonly type: 'limit' | 'market';
  readonly timeInForce: 'GTC' | 'IOC' | 'FOK';
  readonly price: bigint | null;
  readonly qty: bigint;
  readonly postOnly: boolean;
  readonly accountId: string;
  readonly timestampMs: number;
}

export interface EngineClient {
  readonly market: string;
  place(command: PlaceCommand): Promise<EngineResult>;
  cancel(orderId: string, timestampMs: number): Promise<EngineResult>;
  amend(input: {
    orderId: string;
    newOrderId: string;
    price: bigint;
    qty: bigint;
    timestampMs: number;
  }): Promise<EngineResult>;
  lookup(clientOrderId: string): Promise<LookupResult>;
  events(afterSeq: bigint, limit: number): Promise<readonly EngineEvent[] | null>;
  book(): Promise<EngineBook | null>;
  health(): Promise<EngineHealth | null>;
}

// ---------------------------------------------------------------------------
// Signing (ADR-0031) — the canonical string, copied field for field from Rust.
// ---------------------------------------------------------------------------

/** PKCS#8 wrapper for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function engineKeyFromSeed(seedBase64: string): KeyObject {
  const seed = Buffer.from(seedBase64, 'base64');
  if (seed.length !== 32) throw new Error('engine caller seed must be 32 bytes');
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * The public half, base64 of the raw 32 bytes — exactly what the engine's
 * `MATCHING_CALLER_PUBLIC_KEY` expects. Printed at boot so it need not be
 * derived by hand.
 */
export function enginePublicKeyBase64(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('could not export the engine caller public key');
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

/**
 * `method \n path-and-query \n request_id \n hex(sha256(body)) \n timestamp`.
 *
 * The query string is INSIDE what is signed. S2 found that verifying the path
 * alone let a captured `GET /v1/events?after=0` be rewritten to any other
 * range with the signature still valid.
 */
export function canonicalString(input: {
  method: string;
  pathAndQuery: string;
  requestId: string;
  body: Uint8Array;
  timestamp: number;
}): string {
  const hash = createHash('sha256').update(input.body).digest('hex');
  return `${input.method}\n${input.pathAndQuery}\n${input.requestId}\n${hash}\n${String(input.timestamp)}`;
}

export function signRequest(key: KeyObject, canonical: string): string {
  return sign(null, Buffer.from(canonical, 'utf8'), key).toString('base64');
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * JSON.parse with every long integer preserved.
 *
 * The engine serialises `u64` as a JSON NUMBER, and `JSON.parse` turns any
 * integer above 2^53 into the nearest double — silently. A quantity or a
 * sequence that large would arrive wrong and nothing would say so. Quoting
 * every integer literal of 16+ digits before parsing, then reading each field
 * through `BigInt`, keeps them exact whatever their size.
 */
export function parseEngineJson(text: string): unknown {
  return JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}

const big = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') return BigInt(value);
  throw new TypeError(`expected an integer, got ${typeof value}`);
};

function decodeEvent(raw: unknown): EngineEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const [tag, body] = Object.entries(raw as Record<string, Record<string, unknown>>)[0] ?? [];
  if (!tag || !body) return null;
  switch (tag) {
    case 'Accepted':
      return {
        kind: 'accepted',
        seq: big(body.seq),
        orderId: String(body.order_id),
        restingQty: big(body.resting_qty),
      };
    case 'Rejected':
      return {
        kind: 'rejected',
        seq: big(body.seq),
        orderId: String(body.order_id),
        reason: String(body.reason),
      };
    case 'Fill':
      return {
        kind: 'fill',
        seq: big(body.seq),
        fillId: String(body.fill_id),
        takerOrderId: String(body.taker_order_id),
        makerOrderId: String(body.maker_order_id),
        takerSide: body.taker_side === 'sell' ? 'sell' : 'buy',
        price: big(body.price),
        qty: big(body.qty),
      };
    case 'Cancelled':
      return {
        kind: 'cancelled',
        seq: big(body.seq),
        orderId: String(body.order_id),
        remainingQty: big(body.remaining_qty),
      };
    case 'Expired':
      return {
        kind: 'expired',
        seq: big(body.seq),
        orderId: String(body.order_id),
        remainingQty: big(body.remaining_qty),
      };
    case 'StatusChanged':
      return { kind: 'status_changed', seq: big(body.seq) };
    default:
      return null;
  }
}

/**
 * JSON.stringify with `bigint` written as an exact integer literal.
 *
 * The engine reads `u64` from JSON numbers. `Number(x)` would round anything
 * above 2^53 on the way OUT — the same silent corruption `parseEngineJson`
 * prevents on the way in — so bigints are emitted as their exact digits.
 */
export function stringifyEngineJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? `__u64__${v.toString()}__` : v,
  ).replace(/"__u64__(\d+)__"/g, '$1');
}

// ---------------------------------------------------------------------------
// The HTTP client
// ---------------------------------------------------------------------------

export interface HttpEngineClientOptions {
  readonly market: string;
  readonly baseUrl: string;
  readonly key: KeyObject;
  readonly timeoutMs: number;
  /** Seconds. Injected for tests; the engine checks it against its own clock. */
  readonly now?: () => number;
}

export function createHttpEngineClient(options: HttpEngineClientOptions): EngineClient {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call(
    method: string,
    pathAndQuery: string,
    body: unknown,
  ): Promise<{ status: number; json: unknown } | { failure: string }> {
    const bytes = body === undefined ? new Uint8Array() : Buffer.from(stringifyEngineJson(body));
    const requestId = randomUUID();
    const timestamp = now();
    const signature = signRequest(
      options.key,
      canonicalString({ method, pathAndQuery, requestId, body: bytes, timestamp }),
    );
    try {
      const response = await fetch(`${base}${pathAndQuery}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-atlas-signature': signature,
          'x-atlas-request-id': requestId,
          'x-atlas-timestamp': String(timestamp),
        },
        ...(body === undefined ? {} : { body: bytes }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const text = await response.text();
      return { status: response.status, json: text === '' ? null : parseEngineJson(text) };
    } catch (error) {
      return { failure: error instanceof Error ? error.name : 'unknown' };
    }
  }

  function toResult(reply: Awaited<ReturnType<typeof call>>): EngineResult {
    if ('failure' in reply) {
      // Timed out or dropped AFTER the request may have left. The engine may
      // have acted, so this is ambiguous — never a failure to act.
      return { kind: 'ambiguous', cause: reply.failure };
    }
    const body = (reply.json ?? {}) as { seq?: unknown; events?: unknown[]; error?: unknown };
    if (reply.status === 200) {
      const events = (body.events ?? [])
        .map(decodeEvent)
        .filter((e): e is EngineEvent => e !== null);
      return { kind: 'ok', seq: big(body.seq ?? 0), events };
    }
    if (reply.status === 503 || reply.status >= 500) {
      // ADR-0030: journaled, book mutated, events not confirmed on the stream.
      return { kind: 'ambiguous', cause: `engine_${String(reply.status)}` };
    }
    if (reply.status === 409) {
      // A reused request id. We mint a fresh one per call, so this is a gateway
      // bug — and the ORIGINAL request with that id may have succeeded, which
      // makes it ambiguous rather than refused.
      return { kind: 'ambiguous', cause: 'engine_409_request_id_reused' };
    }
    return { kind: 'refused', status: reply.status, error: String(body.error ?? 'unknown') };
  }

  return {
    market: options.market,

    async place(command) {
      return toResult(
        await call('POST', '/v1/orders', {
          order_id: command.orderId,
          timestamp_ms: command.timestampMs,
          request: {
            // The engine's lookup index is GLOBAL, but a client order id is only
            // unique per user. So the engine is handed the gateway's own order
            // UUID — globally unique — or the sweeper could resolve one user's
            // order from another user's journal entry.
            client_order_id: command.orderId,
            side: command.side,
            order_type: command.type,
            time_in_force: command.timeInForce,
            price: command.price,
            qty: command.qty,
            post_only: command.postOnly,
            stp_mode: 'cancel_taker',
            account_id: command.accountId,
          },
        }),
      );
    },

    async cancel(orderId, timestampMs) {
      return toResult(
        await call('DELETE', `/v1/orders/${encodeURIComponent(orderId)}`, {
          timestamp_ms: timestampMs,
        }),
      );
    },

    async amend(input) {
      return toResult(
        await call('PATCH', `/v1/orders/${encodeURIComponent(input.orderId)}`, {
          timestamp_ms: input.timestampMs,
          new_order_id: input.newOrderId,
          price: input.price,
          qty: input.qty,
        }),
      );
    },

    async lookup(clientOrderId) {
      const reply = await call(
        'GET',
        `/v1/orders/lookup?clientOrderId=${encodeURIComponent(clientOrderId)}`,
        undefined,
      );
      if ('failure' in reply) return { outcome: 'unreachable', cause: reply.failure };
      if (reply.status !== 200)
        return { outcome: 'unreachable', cause: `engine_${String(reply.status)}` };
      const body = reply.json as { outcome?: string; seq?: unknown; order_id?: unknown };
      if (body.outcome === 'seen') {
        return { outcome: 'seen', seq: big(body.seq), orderId: String(body.order_id) };
      }
      if (body.outcome === 'never_seen') return { outcome: 'never_seen' };
      // Anything else — `rebuilding` or a shape we do not recognise — is NOT
      // "never seen". Only an explicit never_seen may release a hold.
      return { outcome: 'rebuilding' };
    },

    async events(afterSeq, limit) {
      const reply = await call(
        'GET',
        `/v1/events?after=${afterSeq.toString()}&limit=${String(limit)}`,
        undefined,
      );
      if ('failure' in reply || reply.status !== 200) return null;
      const body = reply.json as { events?: unknown[] };
      return (body.events ?? []).map(decodeEvent).filter((e): e is EngineEvent => e !== null);
    },

    async book() {
      const reply = await call('GET', '/v1/book', undefined);
      if ('failure' in reply || reply.status !== 200) return null;
      const body = reply.json as {
        seq?: unknown;
        reference_price?: unknown;
        bids?: Array<{ price: unknown }>;
        asks?: Array<{ price: unknown }>;
      };
      return {
        seq: big(body.seq ?? 0),
        referencePrice:
          body.reference_price === null || body.reference_price === undefined
            ? null
            : big(body.reference_price),
        bestBid: body.bids?.[0] ? big(body.bids[0].price) : null,
        bestAsk: body.asks?.[0] ? big(body.asks[0].price) : null,
      };
    },

    async health() {
      try {
        const response = await fetch(`${base}/v1/health`, {
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        if (response.status !== 200) return null;
        const body = parseEngineJson(await response.text()) as Record<string, unknown>;
        return {
          market: String(body.market),
          status: String(body.status) as EngineStatus,
          tickSize: big(body.tick_size),
          lotSize: big(body.lot_size),
          minNotional: big(body.min_notional),
          collarBps: Number(body.collar_bps),
          lastSeq: big(body.last_seq),
        };
      } catch {
        return null;
      }
    },
  };
}
