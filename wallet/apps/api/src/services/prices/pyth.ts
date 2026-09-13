import type { PriceRequest, PriceSource, Quote } from './source.js';

/**
 * Pyth, via a Hermes endpoint.
 *
 * # The state of the public endpoint, as found
 *
 * `hermes.pyth.network/v2/price_feeds` (metadata) answers anonymously;
 * `/v2/updates/price/latest` — the one that returns actual prices — replies
 * **401 unauthorized**. So Pyth is not usable here without a credentialed
 * endpoint or a self-hosted Hermes, and `PRICE_SOURCE=pyth` therefore requires
 * `PRICE_ENDPOINT` to be set to one.
 *
 * It is implemented anyway because an oracle a deployment runs itself is a
 * better trust story than an aggregator's REST API, and because the feed ids
 * below were read from the live metadata endpoint rather than remembered.
 *
 * # Why the price is reconstructed rather than read
 *
 * Pyth returns a mantissa and an exponent — `{ price: "10205123456", expo: -8 }`
 * — and NOT a decimal. Multiplying by `10 ** expo` in floating point is how a
 * $102.05 price becomes $102.04999999999998. The string is assembled instead,
 * so what reaches `NUMERIC(18,6)` is exact.
 */
const DEFAULT_ENDPOINT = 'https://hermes.pyth.network';

/**
 * Mainnet feed ids, read from Hermes' own `/v2/price_feeds` metadata.
 *
 * Mainnet feeds are used for every cluster on purpose: a devnet mint is a mock
 * with no market, and the symbol is what carries across clusters.
 */
const DEFAULT_FEEDS: Readonly<Record<string, string>> = {
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  USDC: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  USDT: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
};

export interface PythOptions {
  readonly endpoint?: string;
  readonly apiKey?: string | undefined;
  readonly requestTimeoutMs?: number;
  /** Extra or overriding symbol → feed id mappings, from configuration. */
  readonly feeds?: Readonly<Record<string, string>>;
}

export function createPythSource(options: PythOptions = {}): PriceSource {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  const feeds = { ...DEFAULT_FEEDS, ...options.feeds };

  return {
    name: 'pyth',

    async fetch(requests: readonly PriceRequest[]): Promise<Quote[]> {
      const wanted = new Map<string, string>();
      for (const request of requests) {
        const id = feeds[request.symbol.toUpperCase()];
        if (id !== undefined) wanted.set(id.toLowerCase(), request.symbol);
      }
      if (wanted.size === 0) return [];

      const url = new URL(`${endpoint}/v2/updates/price/latest`);
      for (const id of wanted.keys()) url.searchParams.append('ids[]', id);
      url.searchParams.set('parsed', 'true');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await globalThis.fetch(url, {
          headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`pyth hermes responded ${String(response.status)}`);
        }

        const body: unknown = await response.json();
        return parseUpdates(body, wanted);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function parseUpdates(body: unknown, wanted: ReadonlyMap<string, string>): Quote[] {
  if (typeof body !== 'object' || body === null) return [];
  const parsed = (body as Record<string, unknown>).parsed;
  if (!Array.isArray(parsed)) return [];

  const quotes: Quote[] = [];

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const id = typeof record.id === 'string' ? record.id.toLowerCase() : undefined;
    const symbol = id === undefined ? undefined : wanted.get(id);
    if (symbol === undefined) continue;

    const price = record.price;
    if (typeof price !== 'object' || price === null) continue;
    const fields = price as Record<string, unknown>;

    if (typeof fields.price !== 'string' || typeof fields.expo !== 'number') continue;
    const publishTime = typeof fields.publish_time === 'number' ? fields.publish_time : undefined;

    try {
      quotes.push({
        symbol,
        priceUsd: scale(fields.price, fields.expo),
        observedAt: publishTime === undefined ? new Date() : new Date(publishTime * 1000),
      });
    } catch {
      // A feed that returned something unscalable is skipped, not fatal: the
      // other assets in the same response are still good.
    }
  }

  return quotes;
}

/**
 * `("10205123456", -8)` → `"102.05123456"`, by moving the point in the STRING.
 *
 * No `Number`, no `10 ** expo`, no multiplication. The mantissa can exceed
 * 2^53 for a high-precision feed, and the whole reason this layer exists is to
 * hand `NUMERIC(18,6)` something exact.
 */
function scale(mantissa: string, expo: number): string {
  if (!/^-?\d+$/.test(mantissa)) throw new RangeError(`not an integer mantissa: ${mantissa}`);
  if (!Number.isInteger(expo) || expo > 0 || expo < -18) {
    throw new RangeError(`unsupported exponent: ${String(expo)}`);
  }

  const negative = mantissa.startsWith('-');
  const digits = (negative ? mantissa.slice(1) : mantissa).replace(/^0+(?=\d)/, '');
  const places = -expo;

  if (places === 0) return `${negative ? '-' : ''}${digits}`;

  const padded = digits.padStart(places + 1, '0');
  const whole = padded.slice(0, padded.length - places);
  const fraction = padded.slice(padded.length - places);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
