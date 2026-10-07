import { describe, expect, it } from 'vitest';
import { createBinanceSource, createRandomWalkSource, walkOffset } from './reference-price.js';

const MARKET = { symbol: 'SOL-USDC', tickSize: 1_000n, baseDecimals: 9, quoteDecimals: 6 };
const START = 150_000_000n;

describe('the random walk', () => {
  const at = (ms: number, seed = 7) =>
    createRandomWalkSource({
      seed,
      start: { 'SOL-USDC': START },
      stepMs: 1_000,
      clock: () => new Date(ms),
    }).price(MARKET);

  it('is the same series for the same seed, on any machine and after any restart', async () => {
    const first = await Promise.all([0, 1_000, 2_000, 60_000, 3_600_000].map((ms) => at(ms)));
    const again = await Promise.all([0, 1_000, 2_000, 60_000, 3_600_000].map((ms) => at(ms)));
    expect(again).toEqual(first);
    // A different seed is a different market.
    expect((await at(3_600_000, 8))?.price).not.toBe(first[4]?.price);
  });

  it('never leaves its band, never reaches zero, and is always on a tick', async () => {
    let low = START;
    let high = START;
    for (let step = 0; step < 20_000; step += 37) {
      const offset = walkOffset(7, 'SOL-USDC', step);
      expect(offset >= -1_000_000n && offset <= 1_000_000n).toBe(true);
      const { price } = (await at(step * 1_000))!;
      expect(price % 1_000n).toBe(0n);
      expect(price > 0n).toBe(true);
      if (price < low) low = price;
      if (price > high) high = price;
    }
    // 3% either side by default.
    expect(low >= (START * 97n) / 100n).toBe(true);
    expect(high <= (START * 103n) / 100n).toBe(true);
    // ...and it does actually move.
    expect(high - low > START / 200n).toBe(true);
  });

  it('names each step, and times it by the step — not by when it was asked', async () => {
    const a = (await at(5_000))!;
    const b = (await at(5_999))!;
    expect(a).toEqual(b);
    expect(a.generation).toBe('rw:5');
    expect(a.observedAt.getTime()).toBe(5_000);
    expect((await at(6_000))!.generation).toBe('rw:6');
  });

  it('has nothing to say about a market it was not given a start for', async () => {
    expect(
      await createRandomWalkSource({ seed: 1, start: {}, stepMs: 1_000 }).price(MARKET),
    ).toBeNull();
  });
});

describe('the exchange feed, against recorded responses', () => {
  const recorded = (body: unknown, ok = true): typeof fetch =>
    (async () =>
      ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
  const source = (fetchImpl: typeof fetch) =>
    createBinanceSource({ symbols: { 'SOL-USDC': 'SOLUSDC' }, fetch: fetchImpl });

  it('reads the last trade as a scaled integer, with the exchange’s own time', async () => {
    const price = await source(
      recorded([{ id: 991, price: '150.12345678', qty: '1.5', time: 1_760_000_000_123 }]),
    ).price(MARKET);
    expect(price).toEqual({
      // Truncated to the market's six price decimals, then to its tick.
      price: 150_123_000n,
      observedAt: new Date(1_760_000_000_123),
      generation: 'bn:991',
    });
  });

  it('is exact where a float would not be', async () => {
    const price = await source(
      recorded([{ id: 1, price: '0.30000000', time: 1_760_000_000_000 }]),
    ).price({ ...MARKET, tickSize: 1n });
    // 0.1 + 0.2 in a double is not 0.3. This never was one.
    expect(price?.price).toBe(300_000n);
  });

  it.each([
    ['a failed request', recorded([], false)],
    ['an empty list', recorded([])],
    ['a different shape', recorded({ price: '150' })],
    ['a price that is not a number', recorded([{ id: 1, price: 'NaN', time: 1 }])],
    ['a zero price', recorded([{ id: 1, price: '0.00', time: 1 }])],
    [
      'a network error',
      (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    ],
  ])('says nothing on %s, rather than inventing a price', async (_name, fetchImpl) => {
    expect(await source(fetchImpl).price(MARKET)).toBeNull();
  });

  it('does not know a market it has no ticker for', async () => {
    expect(await source(recorded([])).price({ ...MARKET, symbol: 'BTC-USDC' })).toBeNull();
  });
});
