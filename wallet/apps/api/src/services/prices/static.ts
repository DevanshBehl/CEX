import type { PriceRequest, PriceSource, Quote } from './source.js';

/**
 * Fixed prices, from configuration.
 *
 * For local development against a validator with no internet, and for tests
 * that need a valuation to be an exact number rather than whatever the market
 * did this minute.
 *
 * It is NOT a fallback for a failing feed. A stale-but-plausible number
 * presented as a live price is worse than no price at all: the interface can
 * say "no price yet", and it cannot say "this one is made up".
 */
export function createStaticSource(prices: Readonly<Record<string, string>>): PriceSource {
  return {
    name: 'static',

    async fetch(requests: readonly PriceRequest[]): Promise<Quote[]> {
      await Promise.resolve();
      const observedAt = new Date();

      return requests
        .map((request) => ({ request, priceUsd: prices[request.symbol.toUpperCase()] }))
        .filter(
          (entry): entry is { request: PriceRequest; priceUsd: string } =>
            entry.priceUsd !== undefined,
        )
        .map(({ request, priceUsd }) => ({ symbol: request.symbol, priceUsd, observedAt }));
    },
  };
}
