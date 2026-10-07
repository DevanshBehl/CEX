'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OrderView, TradingBalance, UserFillView } from '@wallet/types';
import { api } from '@/lib/api';
import { useNetwork } from '@/features/network/network-context';
import { useSocket } from './socket-context';

/**
 * The signed-in user's side of a market: their orders, their fills, their
 * trading balances (prompt_phase_s5.md §9, rules 121, 126, 127).
 *
 * REST is the source. Everything here is fetched on mount and again on every
 * (re)connection of the socket; the private channel only says when to look
 * sooner. A message from it is applied because it is fresher, never because it
 * is the record — and it is never used to compute anything:
 *
 *   - an order update REPLACES the order with that id;
 *   - a fill is added if its id is new;
 *   - `balances.changed` carries no number. It triggers a fetch.
 *
 * Nothing in this file subtracts a fill from a balance.
 */

const HISTORY_PAGE = 50;

export interface AccountState {
  readonly orders: OrderView[];
  readonly fills: UserFillView[];
  readonly balances: TradingBalance[];
  readonly loading: boolean;
  readonly error: string | null;
  /** More history exists than is loaded. */
  readonly ordersCursor: string | null;
  readonly fillsCursor: string | null;
}

const INITIAL: AccountState = {
  orders: [],
  fills: [],
  balances: [],
  loading: true,
  error: null,
  ordersCursor: null,
  fillsCursor: null,
};

const newestFirst = (a: OrderView, b: OrderView): number =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;

export function useAccount(market: string | undefined) {
  const { client, connection } = useSocket();
  const { cluster, version } = useNetwork();
  const [state, setState] = useState<AccountState>(INITIAL);

  const refreshBalances = useCallback(async () => {
    try {
      const { balances } = await api.listTradingBalances();
      setState((current) => ({ ...current, balances }));
    } catch {
      // The last fetched balances stay. They are marked by the page's own
      // connection notice; inventing a number here would be worse.
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!market) return;
    try {
      const [orders, fills, balances] = await Promise.all([
        api.listOrders({ market, limit: HISTORY_PAGE }),
        api.listFills({ market, limit: HISTORY_PAGE }),
        api.listTradingBalances(),
      ]);
      setState({
        orders: orders.orders,
        fills: fills.fills,
        balances: balances.balances,
        loading: false,
        error: null,
        ordersCursor: orders.nextBefore,
        fillsCursor: fills.nextBefore,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'Could not load your orders.',
      }));
    }
  }, [market]);

  // On mount, on a network switch, and on EVERY reconnect: whatever the
  // private channel did not deliver while disconnected is recovered here.
  useEffect(() => {
    setState(INITIAL);
    void refresh();
  }, [refresh, version, connection]);

  useEffect(() => {
    if (!client || !cluster) return;
    return client.subscribe({ channel: 'account', cluster }, (message) => {
      if (message.type === 'order') {
        if (message.order.market !== market) return;
        setState((current) => ({
          ...current,
          // Replacement: a duplicate or a late update converges.
          orders: [message.order, ...current.orders.filter((o) => o.id !== message.order.id)].sort(
            newestFirst,
          ),
        }));
      } else if (message.type === 'fill') {
        if (message.fill.market !== market) return;
        setState((current) =>
          current.fills.some((fill) => fill.id === message.fill.id)
            ? current
            : { ...current, fills: [message.fill, ...current.fills] },
        );
      } else if (message.type === 'balances.changed') {
        // Told to look. The number comes from the ledger, by asking.
        void refreshBalances();
      }
    });
  }, [client, cluster, market, refreshBalances]);

  const loadMoreOrders = useCallback(async () => {
    if (!market || state.ordersCursor === null) return;
    const page = await api.listOrders({ market, limit: HISTORY_PAGE, before: state.ordersCursor });
    setState((current) => ({
      ...current,
      orders: [
        ...current.orders,
        ...page.orders.filter((o) => !current.orders.some((x) => x.id === o.id)),
      ],
      ordersCursor: page.nextBefore,
    }));
  }, [market, state.ordersCursor]);

  const loadMoreFills = useCallback(async () => {
    if (!market || state.fillsCursor === null) return;
    const page = await api.listFills({ market, limit: HISTORY_PAGE, before: state.fillsCursor });
    setState((current) => ({
      ...current,
      fills: [
        ...current.fills,
        ...page.fills.filter((f) => !current.fills.some((x) => x.id === f.id)),
      ],
      fillsCursor: page.nextBefore,
    }));
  }, [market, state.fillsCursor]);

  return { ...state, refresh, refreshBalances, loadMoreOrders, loadMoreFills };
}
