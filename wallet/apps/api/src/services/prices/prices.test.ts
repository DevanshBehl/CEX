import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoinGeckoSource } from './coingecko.js';
import { createPythSource } from './pyth.js';
import { createStaticSource } from './static.js';
import { toDecimalString } from './source.js';

/**
 * Price sources (Task 3).
 *
 * What matters here is that a number arriving over HTTP reaches
 * `NUMERIC(18,6)` as the value the feed meant. Everything downstream —
 * the valuation, the chart, the delta — is exact integer arithmetic, and it is
 * worth nothing if the input was already mangled.
 */
function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decimal rendering', () => {
  it('never produces exponential notation', () => {
    // `String(0.000001)` is "1e-6", which NUMERIC rejects — and the whole
    // cycle fails on one cheap asset.
    expect(toDecimalString(0.000001)).not.toContain('e');
    expect(toDecimalString(0.000001)).toBe('0.000001');
  });

  it('keeps a plain price plain', () => {
    expect(toDecimalString(102.05)).toBe('102.05');
    expect(toDecimalString(1)).toBe('1.0');
  });

  it('refuses a price that cannot be one', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toDecimalString(bad)).toThrow(RangeError);
    }
  });
});

describe('coingecko', () => {
  it('maps symbols to coin ids and returns quotes', async () => {
    const fetchMock = mockFetch(200, {
      solana: { usd: 102.05 },
      'usd-coin': { usd: 0.999872 },
    });

    const quotes = await createCoinGeckoSource().fetch([{ symbol: 'SOL' }, { symbol: 'USDC' }]);

    expect(quotes).toEqual([
      { symbol: 'SOL', priceUsd: '102.05', observedAt: expect.any(Date) },
      { symbol: 'USDC', priceUsd: '0.999872', observedAt: expect.any(Date) },
    ]);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('ids=solana%2Cusd-coin');
    expect(url).toContain('vs_currencies=usd');
  });

  it('SKIPS an unmapped symbol rather than guessing an id', async () => {
    // Guessing a coin id is how a balance gets valued at another token's
    // price. Absent is the safe answer; the valuation marks that point
    // incomplete.
    mockFetch(200, { solana: { usd: 100 } });
    const quotes = await createCoinGeckoSource().fetch([{ symbol: 'SOL' }, { symbol: 'WIF' }]);
    expect(quotes.map((q) => q.symbol)).toEqual(['SOL']);
  });

  it('accepts an override from configuration', async () => {
    mockFetch(200, { dogwifcoin: { usd: 2.5 } });
    const quotes = await createCoinGeckoSource({ ids: { WIF: 'dogwifcoin' } }).fetch([
      { symbol: 'WIF' },
    ]);
    expect(quotes[0]?.priceUsd).toBe('2.5');
  });

  it('makes no request at all when nothing is mappable', async () => {
    const fetchMock = mockFetch(200, {});
    await createCoinGeckoSource().fetch([{ symbol: 'NOPE' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a failure rather than returning an empty answer', async () => {
    // The worker treats a throw as "no prices this cycle" and writes nothing.
    // An empty array would look like a successful cycle that priced nothing,
    // which is a different and less honest claim.
    mockFetch(429, {});
    await expect(createCoinGeckoSource().fetch([{ symbol: 'SOL' }])).rejects.toThrow();
  });

  it('does not throw when the body changes shape', async () => {
    mockFetch(200, { solana: 'unexpected' });
    await expect(createCoinGeckoSource().fetch([{ symbol: 'SOL' }])).resolves.toEqual([]);
  });
});

describe('pyth', () => {
  const SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

  it('reconstructs a price from a mantissa and an exponent, in strings', async () => {
    /*
     * `10205123456 × 10^-8` in floating point is 102.04999999999998. Pyth
     * returns the two halves precisely so a consumer does not have to do
     * that — and this is the consumer.
     */
    mockFetch(200, {
      parsed: [
        {
          id: SOL_FEED,
          price: { price: '10205123456', expo: -8, publish_time: 1_757_000_000 },
        },
      ],
    });

    const quotes = await createPythSource({ endpoint: 'https://hermes.test' }).fetch([
      { symbol: 'SOL' },
    ]);

    expect(quotes[0]?.priceUsd).toBe('102.05123456');
    expect(quotes[0]?.observedAt.toISOString()).toBe(new Date(1_757_000_000_000).toISOString());
  });

  it('handles a mantissa beyond 2^53', async () => {
    mockFetch(200, {
      parsed: [{ id: SOL_FEED, price: { price: '90071992547409931', expo: -8 } }],
    });
    const quotes = await createPythSource().fetch([{ symbol: 'SOL' }]);
    expect(quotes[0]?.priceUsd).toBe('900719925.47409931');
  });

  it('pads a mantissa shorter than its exponent', async () => {
    mockFetch(200, { parsed: [{ id: SOL_FEED, price: { price: '5', expo: -8 } }] });
    const quotes = await createPythSource().fetch([{ symbol: 'SOL' }]);
    expect(quotes[0]?.priceUsd).toBe('0.00000005');
  });

  it('skips one unscalable feed without losing the others', async () => {
    mockFetch(200, {
      parsed: [
        { id: SOL_FEED, price: { price: 'not-a-number', expo: -8 } },
        {
          id: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
          price: { price: '100000000', expo: -8 },
        },
      ],
    });

    const quotes = await createPythSource().fetch([{ symbol: 'SOL' }, { symbol: 'USDC' }]);
    expect(quotes.map((q) => q.symbol)).toEqual(['USDC']);
  });

  it('ignores a feed id it did not ask for', async () => {
    mockFetch(200, { parsed: [{ id: 'deadbeef', price: { price: '1', expo: 0 } }] });
    await expect(createPythSource().fetch([{ symbol: 'SOL' }])).resolves.toEqual([]);
  });

  it('asks for the ids it was configured with', async () => {
    const fetchMock = mockFetch(200, { parsed: [] });
    await createPythSource().fetch([{ symbol: 'SOL' }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(SOL_FEED);
  });
});

describe('static prices', () => {
  it('returns what it was configured with, and nothing else', async () => {
    const source = createStaticSource({ SOL: '100.000000' });
    const quotes = await source.fetch([{ symbol: 'SOL' }, { symbol: 'USDC' }]);

    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ symbol: 'SOL', priceUsd: '100.000000' });
  });

  it('is case-insensitive on the symbol', async () => {
    const quotes = await createStaticSource({ SOL: '1' }).fetch([{ symbol: 'sol' }]);
    expect(quotes).toHaveLength(1);
  });
});
