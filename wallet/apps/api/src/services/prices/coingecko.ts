import type { PriceRequest, PriceSource, Quote } from './source.js';
import { toDecimalString } from './source.js';

/**
 * CoinGecko's simple-price endpoint.
 *
 * The default source because it needs no credentials, covers every asset this
 * platform allowlists, and is one request for all of them. Its free tier is
 * rate-limited to roughly 10-30 calls a minute, which is why the worker polls
 * on a timer measured in minutes rather than seconds — one call per cycle for
 * every asset at once.
 *
 * An API key is optional and only raises the limit.
 */
const DEFAULT_ENDPOINT = 'https://api.coingecko.com/api/v3';

/**
 * Symbol to CoinGecko coin id.
 *
 * THE DEVNET MAPPING LIVES HERE. A devnet USDC mint is a mock with no market,
 * so it is priced from the real USDC market: the symbol is what carries across
 * clusters, and the mint address — which is different on every cluster — is
 * not something any feed indexes.
 *
 * That is a deliberate fiction and worth naming: a devnet balance is valued as
 * if it were the real asset. It is the only way a test cluster teaches anything
 * about a portfolio, and the interface says "Devnet — test funds only" beside
 * it (ADR-0021).
 */
const DEFAULT_IDS: Readonly<Record<string, string>> = {
  SOL: 'solana',
  USDC: 'usd-coin',
  USDT: 'tether',
};

export interface CoinGeckoOptions {
  readonly endpoint?: string;
  readonly apiKey?: string | undefined;
  readonly requestTimeoutMs?: number;
  /** Extra or overriding symbol → coin id mappings, from configuration. */
  readonly ids?: Readonly<Record<string, string>>;
}

export function createCoinGeckoSource(options: CoinGeckoOptions = {}): PriceSource {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  const ids = { ...DEFAULT_IDS, ...options.ids };

  return {
    name: 'coingecko',

    async fetch(requests: readonly PriceRequest[]): Promise<Quote[]> {
      const wanted = new Map<string, string>();
      for (const request of requests) {
        const id = ids[request.symbol.toUpperCase()];
        // An unmapped symbol is skipped, not guessed. Guessing a coin id is how
        // a balance gets valued at the price of a different token entirely.
        if (id !== undefined) wanted.set(id, request.symbol);
      }
      if (wanted.size === 0) return [];

      const url = new URL(`${endpoint}/simple/price`);
      url.searchParams.set('ids', [...wanted.keys()].join(','));
      url.searchParams.set('vs_currencies', 'usd');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await globalThis.fetch(url, {
          headers: options.apiKey ? { 'x-cg-demo-api-key': options.apiKey } : {},
          signal: controller.signal,
        });

        if (!response.ok) {
          // The URL can carry a key, so neither it nor the body is forwarded.
          throw new Error(`coingecko responded ${String(response.status)}`);
        }

        const body: unknown = await response.json();
        const observedAt = new Date();
        const quotes: Quote[] = [];

        for (const [id, symbol] of wanted) {
          const usd = readUsd(body, id);
          if (usd === undefined) continue;
          quotes.push({ symbol, priceUsd: toDecimalString(usd), observedAt });
        }

        return quotes;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Parsed defensively: a feed changing shape must not throw three layers up. */
function readUsd(body: unknown, id: string): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const entry = (body as Record<string, unknown>)[id];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const usd = (entry as Record<string, unknown>).usd;
  return typeof usd === 'number' ? usd : undefined;
}
