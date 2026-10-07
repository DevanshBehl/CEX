import { z } from 'zod';
import { parseDecimal, priceDecimals } from '@wallet/types';

/**
 * Where the demo market maker quotes around (ADR-0038 §7).
 *
 * NOT `PriceSource`. That interface answers "what is this asset worth in
 * dollars" as a decimal string, for valuing a portfolio. This one answers
 * "where should THIS MARKET be quoted", as a scaled integer in the market's
 * own quote asset — the unit an order price is in.
 */

export interface ReferencePrice {
  /** Scaled price (ADR-0026), in the market's quote asset. */
  readonly price: bigint;
  /** When the SOURCE observed it. Staleness is judged from this, never from now. */
  readonly observedAt: Date;
  /**
   * Names this observation. Two calls that return the same generation
   * describe the same price, and the maker derives its client order ids from
   * it — so re-issuing a generation after a restart re-submits the same
   * orders, and the gateway's idempotency makes that harmless.
   */
  readonly generation: string;
}

export interface ReferenceMarket {
  readonly symbol: string;
  readonly tickSize: bigint;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
}

export interface ReferencePriceSource {
  readonly name: string;
  /** Null when the source has nothing to say. The maker then quotes nothing. */
  price(market: ReferenceMarket): Promise<ReferencePrice | null>;
}

// ---------------------------------------------------------------------------
// The default: a deterministic walk. Offline, and identical on every machine.
// ---------------------------------------------------------------------------

export interface RandomWalkOptions {
  readonly seed: number;
  /** SYMBOL -> the scaled price the walk is centred on. */
  readonly start: Readonly<Record<string, bigint>>;
  /** How far from `start` it may wander, in basis points. Below 10 000. */
  readonly bandBps?: number;
  /** One step of the walk. */
  readonly stepMs: number;
  readonly clock?: () => Date;
}

/** A 32-bit mix of three integers. Integer arithmetic only. */
function hash(seed: number, symbol: number, n: number): number {
  let h = (seed ^ Math.imul(symbol, 0x9e3779b1) ^ Math.imul(n, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const symbolId = (symbol: string): number => {
  let id = 0;
  for (let i = 0; i < symbol.length; i += 1) id = (Math.imul(id, 31) + symbol.charCodeAt(i)) >>> 0;
  return id;
};

/** Resolution of the walk's offset: parts per million of the band. */
const UNIT = 1_000_000n;

/**
 * The walk's offset at step `n`, in [-UNIT, UNIT].
 *
 * A pure function of `(seed, symbol, n)` — not a running sum, which would need
 * every earlier step to reproduce. Three octaves of interpolated lattice
 * values: slow drift, medium swings, small noise. Bounded by construction, so
 * the price can never leave its band and never reach zero.
 */
export function walkOffset(seed: number, symbol: string, n: number): bigint {
  const id = symbolId(symbol);
  let total = 0n;
  let weight = 0n;
  for (const [octave, period, share] of [
    [1, 240, 6n],
    [2, 40, 3n],
    [3, 6, 1n],
  ] as const) {
    const cell = Math.floor(n / period);
    const within = BigInt(n - cell * period);
    // Lattice values in [-UNIT, UNIT].
    const at = (c: number) => BigInt(hash(seed + octave, id, c) % 2_000_001) - UNIT;
    const a = at(cell);
    const b = at(cell + 1);
    total += share * (a + ((b - a) * within) / BigInt(period));
    weight += share;
  }
  return total / weight;
}

export function createRandomWalkSource(options: RandomWalkOptions): ReferencePriceSource {
  const band = BigInt(options.bandBps ?? 300);
  if (band <= 0n || band >= 10_000n) throw new RangeError('bandBps must be in (0, 10000)');
  const clock = options.clock ?? (() => new Date());

  return {
    name: 'random_walk',
    async price(market) {
      const start = options.start[market.symbol];
      if (start === undefined || start <= 0n) return null;
      const n = Math.floor(clock().getTime() / options.stepMs);
      const offset = walkOffset(options.seed, market.symbol, n);
      // start × (1 + band × offset), in integers.
      const raw = start + (start * band * offset) / (10_000n * UNIT);
      // On a tick, and never below one.
      const ticks = raw / market.tickSize;
      const price = (ticks < 1n ? 1n : ticks) * market.tickSize;
      return {
        price,
        observedAt: new Date(n * options.stepMs),
        generation: `rw:${String(n)}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Opt-in: a real exchange's last trade. Never used by a test.
// ---------------------------------------------------------------------------

const lastTradeSchema = z
  .array(
    z.object({
      id: z.number().int(),
      /** A decimal STRING. It is parsed as one and never becomes a `number`. */
      price: z.string(),
      time: z.number().int().positive(),
    }),
  )
  .min(1);

export interface BinanceSourceOptions {
  /** SYMBOL -> the exchange's ticker, e.g. `SOL-USDC` -> `SOLUSDC`. */
  readonly symbols: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected, so the client is tested against recorded responses. */
  readonly fetch?: typeof fetch;
}

/**
 * The exchange's most recent public trade, with the exchange's own timestamp.
 *
 * It can fail and it can go stale; both are answered by returning what it has
 * (or null) and letting the maker judge the age. It never invents a price, and
 * the maker never falls back from this to the walk.
 */
export function createBinanceSource(options: BinanceSourceOptions): ReferencePriceSource {
  const base = (options.baseUrl ?? 'https://api.binance.com').replace(/\/+$/, '');
  const request = options.fetch ?? fetch;

  return {
    name: 'binance',
    async price(market) {
      const ticker = options.symbols[market.symbol];
      if (ticker === undefined) return null;
      let body: unknown;
      try {
        const response = await request(
          `${base}/api/v3/trades?symbol=${encodeURIComponent(ticker)}&limit=1`,
          { signal: AbortSignal.timeout(options.timeoutMs ?? 3_000) },
        );
        if (!response.ok) return null;
        body = await response.json();
      } catch {
        return null;
      }
      const parsed = lastTradeSchema.safeParse(body);
      if (!parsed.success) return null;
      const trade = parsed.data[parsed.data.length - 1]!;

      const decimals = priceDecimals(market);
      // The feed may quote more decimals than this market's scale carries.
      // Truncating a REFERENCE is harmless — it is rounded to a tick next —
      // where refusing would silence the feed over a digit nobody trades at.
      const [whole = '0', fraction = ''] = trade.price.split('.');
      const scaled = parseDecimal(`${whole}.${fraction.slice(0, decimals) || '0'}`, decimals);
      if (!scaled.ok || scaled.value <= 0n) return null;
      const ticks = scaled.value / market.tickSize;
      if (ticks < 1n) return null;
      return {
        price: ticks * market.tickSize,
        observedAt: new Date(trade.time),
        generation: `bn:${String(trade.id)}`,
      };
    },
  };
}
