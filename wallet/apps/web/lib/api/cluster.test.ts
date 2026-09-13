import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { request } from './client';
import {
  clusterHeader,
  getActiveCluster,
  readStoredCluster,
  setActiveCluster,
  storeCluster,
} from './cluster';

/**
 * The cluster header (ADR-0021).
 *
 * The failure this prevents is quiet: a request made with no cluster is
 * answered for the server's DEFAULT, so a page that had switched to mainnet
 * would render devnet balances and look entirely correct.
 */
const schema = z.object({ ok: z.literal(true) });

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: storage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the cluster header', () => {
  it('is absent before a cluster is chosen', () => {
    // "No opinion" rather than a guess. A client defaulting to devnet while
    // the server defaults to mainnet would label real balances as play money.
    expect(clusterHeader()).toEqual({});
  });

  it('is attached to every request once a cluster is active', async () => {
    setActiveCluster('devnet');
    const fetchMock = mockFetch();

    await request({ method: 'GET', path: '/balances', schema });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-solana-cluster']).toBe('devnet');
  });

  it('does not lose the content-type header when a body is sent', async () => {
    setActiveCluster('devnet');
    const fetchMock = mockFetch();

    await request({ method: 'POST', path: '/withdrawals', body: { a: 1 }, schema });

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-solana-cluster']).toBe('devnet');
  });

  it('changes with the active cluster', async () => {
    setActiveCluster('mainnet-beta');
    const fetchMock = mockFetch();

    await request({ method: 'GET', path: '/balances', schema });
    expect(getActiveCluster()).toBe('mainnet-beta');

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-solana-cluster']).toBe('mainnet-beta');
  });
});

describe('the stored preference', () => {
  it('round-trips a served cluster', () => {
    storeCluster('devnet');
    expect(readStoredCluster(['localnet', 'devnet'])).toBe('devnet');
  });

  it('DISCARDS a preference this deployment no longer serves', () => {
    /*
     * Otherwise every request carries a cluster the server rejects with a 400,
     * and the user cannot clear it without knowing what localStorage is.
     */
    storeCluster('mainnet-beta');
    expect(readStoredCluster(['localnet', 'devnet'])).toBeUndefined();
  });

  it('discards a value that is not a cluster at all', () => {
    window.localStorage.setItem('atlas.cluster', 'mainnet');
    expect(readStoredCluster(['mainnet-beta'])).toBeUndefined();
  });

  it('returns nothing when there is no preference', () => {
    expect(readStoredCluster(['devnet'])).toBeUndefined();
  });

  it('survives storage being unavailable', () => {
    // Private browsing throws on access rather than returning null. A
    // convenience must not break the page.
    vi.stubGlobal('window', {
      localStorage: {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
      },
    });

    expect(readStoredCluster(['devnet'])).toBeUndefined();
    expect(() => storeCluster('devnet')).not.toThrow();
  });
});
