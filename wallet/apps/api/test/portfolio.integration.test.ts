import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPriceRepository } from '@wallet/db';
import {
  browserHeaders,
  creditUser,
  creditUserAt,
  seedSession,
  startHarness,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';

/**
 * Portfolio valuation, end to end (Task 3).
 *
 * The property under test is that a dollar figure is REPRODUCIBLE from the
 * ledger and the price table — no cached total, no balance column, nothing
 * computed in the browser. If the number cannot be derived from those two
 * inputs, it cannot be audited, and a custody platform's headline figure has
 * to be auditable.
 */

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ startPricer: false });
});

afterAll(async () => {
  await h.cleanup();
});

const prices = () => createPriceRepository(h.app.appDeps.db);

/*
 * A DIFFERENT asset per test.
 *
 * Price ticks are shared state: they are keyed by (cluster, asset) and belong
 * to the platform, not to a user. Two tests both pricing `SOL` on the same
 * cluster see each other's ticks, and the failure looks like a valuation bug
 * rather than a fixture one. Balances are already per user; this makes prices
 * per test too.
 */
let counter = 0;
function uniqueAsset(): { key: string; asset: string } {
  counter += 1;
  const asset = `TEST${String(counter)}${String(Date.now() % 100000)}`;
  return { key: `${TEST_CLUSTER}:${asset}`, asset };
}

/** A tick at a chosen instant, so a valuation is an exact number. */
async function priceAt(asset: string, priceUsd: string, at: Date): Promise<void> {
  await prices().record([
    { cluster: TEST_CLUSTER, asset, priceUsd, source: 'test', recordedAt: at },
  ]);
}

function get(url: string, cookie: string) {
  return h.app.inject({ method: 'GET', url, headers: browserHeaders(cookie) });
}

const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000);

// ---------------------------------------------------------------------------

describe('the summary', () => {
  it('values a balance at the latest price', async () => {
    /*
     * A UNIQUE asset, like every other test here.
     *
     * An earlier version priced `SOL` and asserted the total. It passed until
     * the live price worker ran against the same database and recorded a newer
     * SOL tick — at which point "the latest price" was the real market's, not
     * the fixture's, and the assertion failed for a reason that had nothing to
     * do with the code. Price ticks belong to the platform, not to a user.
     */
    const session = await seedSession(h);
    const { key, asset } = uniqueAsset();
    await creditUser(h, session.userId, key, '2000000000');
    await priceAt(asset, '150.000000', hoursAgo(1));

    const response = await get('/portfolio/summary', session.cookie);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0].amount).toBe('2000000000');
    expect(body.allocations[0].valueUsd).toBe('300.000000');
    expect(body.totalUsd).toBe('300.000000');
  });

  it('reports a 24h change against the price as it was THEN', async () => {
    const session = await seedSession(h);
    const { key, asset } = uniqueAsset();
    // Held since before the comparison point, so the only thing that moved is
    // the price. A balance credited "now" would make the delta a deposit.
    await creditUserAt(h, session.userId, key, '1000000000', hoursAgo(48));

    // A price before the comparison point, and one after it.
    await priceAt(asset, '100.000000', hoursAgo(30));
    await priceAt(asset, '150.000000', hoursAgo(1));

    const body = (await get('/portfolio/summary', session.cookie)).json();

    expect(body.totalUsd).toBe('150.000000');
    expect(body.changeUsd).toBe('50.000000');
    expect(body.changeBps).toBe(5_000); // +50%
  });

  it('gives no percentage when there was nothing to grow from', async () => {
    /*
     * A portfolio that went from nothing to something has not risen by any
     * percentage. `∞%` and `0%` are both lies, so the field is null and the
     * interface says "new".
     */
    const session = await seedSession(h);
    const { key, asset } = uniqueAsset();
    await creditUser(h, session.userId, key, '1000000000');
    await priceAt(asset, '150.000000', hoursAgo(1));

    const body = (await get('/portfolio/summary', session.cookie)).json();
    expect(body.changeUsd).toBe('150.000000');
    expect(body.changeBps).toBeNull();
  });

  it('says it is INCOMPLETE rather than valuing an unpriced holding at zero', async () => {
    // A holding nothing can price is not worth nothing. Reporting it as zero
    // would show a fall in someone's net worth that did not happen.
    const session = await seedSession(h);
    const { key } = uniqueAsset();
    await creditUser(h, session.userId, key, '1000000000');

    const body = (await get('/portfolio/summary', session.cookie)).json();
    expect(body.complete).toBe(false);
    expect(body.allocations[0].valueUsd).toBeNull();
  });

  it('is an empty, complete portfolio for a new account', async () => {
    const session = await seedSession(h);
    const body = (await get('/portfolio/summary', session.cookie)).json();

    expect(body.totalUsd).toBe('0.000000');
    expect(body.allocations).toEqual([]);
    expect(body.complete).toBe(true);
  });

  it('requires a session', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/portfolio/summary',
      headers: { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('the history', () => {
  it('returns a point per interval, ending now', async () => {
    const session = await seedSession(h);
    const { key, asset } = uniqueAsset();
    await creditUserAt(h, session.userId, key, '1000000000', hoursAgo(72));
    await priceAt(asset, '100.000000', hoursAgo(48));

    const body = (await get('/portfolio/history?range=24h', session.cookie)).json();

    expect(body.range).toBe('24h');
    expect(body.points).toHaveLength(24);
    expect(new Date(body.points.at(-1).at).getTime()).toBeLessThanOrEqual(Date.now());
    // Ascending.
    for (let i = 1; i < body.points.length; i += 1) {
      expect(new Date(body.points[i].at).getTime()).toBeGreaterThan(
        new Date(body.points[i - 1].at).getTime(),
      );
    }
  });

  it('VALUES EACH POINT WITH THE PRICE AS IT WAS THEN', async () => {
    /*
     * The property that makes a historical chart honest. Valuing yesterday's
     * balance at today's price makes the line move when nothing happened, and
     * the user reads it as a gain they never had.
     */
    const session = await seedSession(h);
    const { key, asset } = uniqueAsset();
    await creditUserAt(h, session.userId, key, '1000000000', hoursAgo(48));

    await priceAt(asset, '100.000000', hoursAgo(20));
    await priceAt(asset, '200.000000', hoursAgo(2));

    const body = (await get('/portfolio/history?range=24h', session.cookie)).json();
    const values = body.points.map((p: { totalUsd: string }) => p.totalUsd);

    // The balance never changed, so every movement here is the price.
    expect(values).toContain('100.000000');
    expect(values).toContain('200.000000');
    expect(values.at(-1)).toBe('200.000000');
  });

  it('carries a balance from BEFORE the window into it', async () => {
    // A balance at time T is the sum of everything before T. A window that
    // started from zero would draw a deposit at its left edge that never
    // happened.
    const session = await seedSession(h);
    const { key, asset } = uniqueAsset();
    await creditUserAt(h, session.userId, key, '3000000000', hoursAgo(96));
    await priceAt(asset, '10.000000', hoursAgo(72));

    const body = (await get('/portfolio/history?range=24h', session.cookie)).json();
    expect(body.points[0].totalUsd).toBe('30.000000');
  });

  it('defaults to 24h and refuses a range it does not offer', async () => {
    const session = await seedSession(h);

    expect((await get('/portfolio/history', session.cookie)).json().range).toBe('24h');

    const bad = await get('/portfolio/history?range=1y', session.cookie);
    expect(bad.statusCode).toBe(400);
  });

  it('offers every range it advertises', async () => {
    const session = await seedSession(h);
    for (const range of ['24h', '7d', '30d', 'all']) {
      const response = await get(`/portfolio/history?range=${range}`, session.cookie);
      expect(response.statusCode, range).toBe(200);
      expect(response.json().points.length).toBeGreaterThan(0);
    }
  });
});

describe('valuation is scoped to the cluster', () => {
  it('does not price one cluster with another cluster’s ticks', async () => {
    /*
     * The price table is keyed by (cluster, asset) for this reason. A mainnet
     * valuation reading a devnet tick — or the reverse — would produce a
     * number that is plausible and wrong.
     */
    const session = await seedSession(h);
    const { key, asset } = uniqueAsset();
    await creditUser(h, session.userId, key, '1000000000');

    await prices().record([
      { cluster: 'mainnet-beta', asset, priceUsd: '999.000000', source: 'test' },
    ]);

    const body = (await get('/portfolio/summary', session.cookie)).json();
    expect(body.cluster).toBe(TEST_CLUSTER);
    // The mainnet tick is invisible here: without a tick on this cluster the
    // holding is unpriced, not priced at $999.
    expect(body.allocations[0].valueUsd).not.toBe('999.000000');
  });
});

describe('the price table is append-only', () => {
  it('refuses an UPDATE, like the ledger', async () => {
    await priceAt('SOL', '1.000000', hoursAgo(1));
    await expect(
      h.app.appDeps.db.$executeRawUnsafe(`UPDATE asset_price_ticks SET price_usd = 2`),
    ).rejects.toThrow();
  });

  it('refuses a DELETE', async () => {
    await expect(
      h.app.appDeps.db.$executeRawUnsafe(`DELETE FROM asset_price_ticks`),
    ).rejects.toThrow();
  });

  it('refuses a non-positive price', async () => {
    await expect(
      prices().record([{ cluster: TEST_CLUSTER, asset: 'SOL', priceUsd: '0', source: 'test' }]),
    ).rejects.toThrow();
  });
});
