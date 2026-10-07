'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandleInterval, CandleView, MarketView, TickerView, TradeView } from '@wallet/types';
import { api, ApiError } from '@/lib/api';
import { useNetwork } from '@/features/network/network-context';
import { applyBookMessage, EMPTY_BOOK, type BookState } from './book-state';
import { useSocket } from './socket-context';

/**
 * The public side of a market: the book, the tape, the ticker, the candles.
 *
 * Each hook holds what the server sent and nothing derived from a guess. Where
 * the socket carries a sequence (the book), a gap is acted on rather than
 * papered over; where it does not (the tape), entries are merged by id so a
 * duplicate cannot appear twice.
 */

const MAX_TAPE = 80;

export function useMarkets() {
  const { version, ready, cluster } = useNetwork();
  const [state, setState] = useState<{
    markets: MarketView[] | null;
    error: string | null;
    /** Trading does not exist on this cluster: not an error, a fact to show. */
    unavailable: boolean;
  }>({ markets: null, error: null, unavailable: false });

  const refresh = useCallback(async () => {
    try {
      const { markets } = await api.listMarkets();
      setState({ markets, error: null, unavailable: false });
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      setState({
        markets: missing ? [] : null,
        error: missing ? null : error instanceof Error ? error.message : 'Could not load markets.',
        unavailable: missing,
      });
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refresh();
    // Status and settlement state change at runtime; a market list is small.
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh, version, ready]);

  return { ...state, cluster, refresh };
}

/**
 * The order book. Coalesced to animation frames: a busy book must not make the
 * order form beside it unresponsive (rule 142).
 */
export function useBook(market: string | undefined): BookState {
  const { client } = useSocket();
  const { cluster } = useNetwork();
  const [book, setBook] = useState<BookState>(EMPTY_BOOK);
  const latest = useRef<BookState>(EMPTY_BOOK);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    latest.current = EMPTY_BOOK;
    setBook(EMPTY_BOOK);
    if (!client || !cluster || !market) return;

    const flush = () => {
      frame.current = null;
      setBook(latest.current);
    };
    const off = client.subscribe({ channel: 'book', cluster, market }, (message) => {
      if (
        message.type !== 'book.snapshot' &&
        message.type !== 'book.delta' &&
        message.type !== 'book.resync'
      ) {
        return;
      }
      const next = applyBookMessage(latest.current, message);
      latest.current = next;
      // A missed sequence: nothing after it can be applied. Reconnecting
      // resubscribes, and a subscription is answered with a snapshot.
      if (next.needsSnapshot) client.reconnect();
      frame.current ??= requestAnimationFrame(flush);
    });
    return () => {
      off();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [client, cluster, market]);

  return book;
}

/** The public tape, newest first, merged by trade id. */
export function useTrades(market: string | undefined): TradeView[] {
  const { client } = useSocket();
  const { cluster } = useNetwork();
  const [trades, setTrades] = useState<TradeView[]>([]);

  useEffect(() => {
    setTrades([]);
    if (!client || !cluster || !market) return;
    const merge = (incoming: readonly TradeView[]) =>
      setTrades((current) => {
        const byId = new Map(current.map((trade) => [trade.id, trade]));
        for (const trade of incoming) byId.set(trade.id, trade);
        // Engine order, never the clock: a trade's time is not monotonic.
        return [...byId.values()]
          .sort((a, b) => {
            const [seqA = '0', indexA = '0'] = a.id.split(':');
            const [seqB = '0', indexB = '0'] = b.id.split(':');
            const seq = BigInt(seqB) - BigInt(seqA);
            return seq !== 0n ? (seq > 0n ? 1 : -1) : Number(indexB) - Number(indexA);
          })
          .slice(0, MAX_TAPE);
      });
    return client.subscribe({ channel: 'trades', cluster, market }, (message) => {
      if (message.type === 'trades.snapshot') merge(message.trades);
      else if (message.type === 'trade') merge([message.trade]);
    });
  }, [client, cluster, market]);

  return trades;
}

export function useTicker(market: MarketView | undefined): TickerView | null {
  const { client } = useSocket();
  const { cluster } = useNetwork();
  const [ticker, setTicker] = useState<TickerView | null>(market?.ticker ?? null);
  const symbol = market?.symbol;
  const initial = market?.ticker ?? null;

  useEffect(() => {
    setTicker(initial);
    // `initial` is deliberately not a dependency: it changes on every poll of
    // the market list, and the live channel is the fresher source.
  }, [symbol]);

  useEffect(() => {
    if (!client || !cluster || !symbol) return;
    return client.subscribe({ channel: 'ticker', cluster, market: symbol }, (message) => {
      // Conflated on the server: each value replaces the last.
      if (message.type === 'ticker') setTicker(message.ticker);
    });
  }, [client, cluster, symbol]);

  return ticker;
}

/**
 * Candles over REST, refetched when the tape moves.
 *
 * Refetched, not patched: a late trade can change a bucket that is no longer
 * the latest (ADR-0036 §6), so "append to the last candle" would be wrong the
 * first time one arrives.
 */
export function useCandles(market: string | undefined, interval: CandleInterval, tick: string) {
  const { connection } = useSocket();
  const [state, setState] = useState<{ candles: CandleView[]; loading: boolean }>({
    candles: [],
    loading: true,
  });

  useEffect(() => {
    if (!market) return;
    let cancelled = false;
    // Trades arrive in bursts; one request covers the burst.
    const timer = setTimeout(() => {
      void api
        .listCandles(market, { interval, limit: 240 })
        .then(({ candles }) => {
          if (!cancelled) setState({ candles, loading: false });
        })
        .catch(() => {
          if (!cancelled) setState((current) => ({ ...current, loading: false }));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [market, interval, tick, connection]);

  return state;
}
