import type { FastifyRequest } from 'fastify';
import {
  createCustodyRepository,
  createLedgerRepository,
  type OrderRecord,
  type PrismaClient,
} from '@wallet/db';
import { NotFoundError, ValidationError } from '@wallet/errors';
import {
  isTerminalOrder,
  ledgerAssetKey,
  orderHoldsFunds,
  parseLedgerAssetKey,
  type AssetRegistry,
  type CancelAllResponse,
  type Cluster,
  type ListMarketsResponse,
  type ListOrdersResponse,
  type ListTradingBalancesResponse,
  type OrderResponse,
  type OrderStatus,
  type OrderView,
  type SettlementState,
  type TickerView,
  type WithdrawalResponse,
} from '@wallet/types';
import { requireSessionRecord } from '../middleware/guards.js';
import type { MarketRegistry } from '../services/trading/markets.js';
import type { OrderService } from '../services/trading/order.service.js';
import type { WithdrawalService } from '../services/withdrawal.service.js';
import { renderWithdrawal } from './withdrawal.controller.js';

/**
 * The trading surface's controllers (prompt_phase_s3.md §§9, 11, 15, 7).
 *
 * Trading lives on ONE cluster — the one its markets were configured for. A
 * request for any other cluster is told trading does not exist there, rather
 * than being answered from the trading cluster and looking correct.
 */
export interface TradingControllerDeps {
  readonly db: PrismaClient;
  readonly cluster: Cluster;
  readonly chainId: string;
  readonly assets: AssetRegistry;
  readonly markets: MarketRegistry;
  readonly orders: OrderService;
  readonly withdrawals: WithdrawalService;
  readonly clearingAddress: string;
  /**
   * What the market view says about settlement and the last day's trading.
   * Supplied by the market-data controllers; absent in a unit that has none.
   */
  readonly marketView?: {
    settlementState(symbol: string): SettlementState;
    tickerFor(symbol: string): Promise<TickerView | null>;
  };
}

export interface TradingControllers {
  markets(request: FastifyRequest): Promise<ListMarketsResponse>;
  balances(request: FastifyRequest): Promise<ListTradingBalancesResponse>;
  place(request: FastifyRequest): Promise<OrderResponse>;
  list(request: FastifyRequest): Promise<ListOrdersResponse>;
  get(request: FastifyRequest): Promise<OrderResponse>;
  cancel(request: FastifyRequest): Promise<OrderResponse>;
  cancelAll(request: FastifyRequest): Promise<CancelAllResponse>;
  amend(request: FastifyRequest): Promise<OrderResponse>;
  allocate(request: FastifyRequest): Promise<WithdrawalResponse>;
  deallocate(request: FastifyRequest): Promise<WithdrawalResponse>;
}

/**
 * Generic, per state. Never an engine reject reason or a risk code: those stay
 * on the order row and in the decision record (ADR-0033).
 */
const STATUS_DETAIL: Readonly<Record<OrderStatus, string>> = {
  PENDING_ENGINE: 'Placing your order.',
  OPEN: 'Open on the book.',
  PARTIALLY_FILLED: 'Partially filled.',
  PENDING_CANCEL: 'Cancelling.',
  FILLED: 'Filled.',
  CANCELLED: 'Cancelled. Any unused funds have been returned.',
  REJECTED: 'This order was not accepted by the market. Your funds have been returned.',
  EXPIRED: 'This order expired without filling. Your funds have been returned.',
  FAILED: 'This order could not be placed. Your funds have been returned.',
};

const wire = (assetKey: string): string => {
  try {
    return parseLedgerAssetKey(assetKey).asset;
  } catch {
    return assetKey;
  }
};

export function toOrderView(row: OrderRecord): OrderView {
  return {
    id: row.id,
    clientOrderId: row.clientOrderId,
    market: row.market.slice(row.market.indexOf(':') + 1),
    side: row.side,
    type: row.kind,
    timeInForce: row.timeInForce,
    postOnly: row.postOnly,
    price: row.price as OrderView['price'],
    qty: row.qty as OrderView['qty'],
    filledQty: row.filledQty as OrderView['filledQty'],
    status: row.status,
    holdAsset: wire(row.holdAsset),
    holdAmount: row.holdAmount as OrderView['holdAmount'],
    holdsFunds: orderHoldsFunds(row.status),
    isTerminal: isTerminalOrder(row.status),
    statusDetail: STATUS_DETAIL[row.status],
    createdAt: row.createdAt.toISOString(),
  };
}

export function createTradingControllers(deps: TradingControllerDeps): TradingControllers {
  function requireTradingCluster(request: FastifyRequest): void {
    if (request.cluster !== deps.cluster) {
      throw new NotFoundError('Trading is not available on this network');
    }
  }

  async function ownAddress(userId: string): Promise<string> {
    const repository = createCustodyRepository(deps.db);
    const wallet = await repository.findWallet(userId, deps.chainId);
    const address = wallet ? await repository.findActiveDepositAddress(wallet.id) : null;
    // A deallocation pays to the user's OWN address. One that has none has
    // never deposited, so it has nothing in the clearing tier either.
    if (!address) throw new NotFoundError('You have no wallet address on this network yet');
    return address.address;
  }

  return {
    async markets(request) {
      requireTradingCluster(request);
      const markets = await Promise.all(
        deps.markets.entries.map(async (entry) => {
          const live = await deps.markets.routable(entry.symbol);
          return {
            symbol: entry.symbol,
            baseAsset: wire(entry.market.baseAsset),
            quoteAsset: wire(entry.market.quoteAsset),
            baseSymbol: entry.baseSymbol,
            quoteSymbol: entry.quoteSymbol,
            baseDecimals: entry.baseDecimals,
            quoteDecimals: entry.quoteDecimals,
            tickSize: entry.market.tickSize,
            lotSize: entry.market.lotSize,
            minNotional: entry.market.minNotional.toString() as never,
            collarBps: entry.market.collarBps,
            // A market the gateway cannot route to is shown halted: it cannot
            // be traded, whatever its engine last said.
            status: live.ok ? live.market.status : ('halted' as const),
            // Coarse: live, delayed, halted or disabled. A market whose fills
            // are not reaching the ledger says so on the screen that trades it.
            settlement: deps.marketView?.settlementState(entry.symbol) ?? ('disabled' as const),
            ticker: (await deps.marketView?.tickerFor(entry.symbol)) ?? null,
          };
        }),
      );
      return { markets };
    },

    async balances(request) {
      requireTradingCluster(request);
      const { userId } = requireSessionRecord(request);
      const rows = await createLedgerRepository(deps.db).getUserTradingBalances(
        userId,
        deps.cluster,
      );
      return {
        balances: rows.map((row) => ({
          asset: wire(row.asset),
          symbol: deps.assets.symbolOf(row.asset),
          decimals: deps.assets.decimalsOf(row.asset),
          available: row.available as never,
          locked: row.locked as never,
          total: row.total as never,
        })),
      };
    },

    async place(request) {
      requireTradingCluster(request);
      const { userId } = requireSessionRecord(request);
      const body = request.body as {
        market: string;
        side: 'buy' | 'sell';
        type: 'limit' | 'market';
        timeInForce: 'GTC' | 'IOC' | 'FOK';
        price: string | null;
        qty: string;
        postOnly: boolean;
        clientOrderId: string;
      };
      const order = await deps.orders.place({
        userId,
        symbol: body.market,
        side: body.side,
        type: body.type,
        timeInForce: body.timeInForce,
        price: body.price,
        qty: body.qty,
        postOnly: body.postOnly,
        clientOrderId: body.clientOrderId,
        correlationId: request.correlationId,
      });
      return { order: toOrderView(order) };
    },

    async list(request) {
      requireTradingCluster(request);
      const { userId } = requireSessionRecord(request);
      const query = request.query as {
        market?: string;
        status: 'open' | 'all';
        limit: number;
        before?: string;
      };
      let before: { createdAt: Date; id: string } | undefined;
      if (query.before !== undefined) {
        const at = query.before.indexOf('.');
        const createdAt = new Date(Number(query.before.slice(0, at)));
        if (at <= 0 || Number.isNaN(createdAt.getTime())) {
          throw new ValidationError([{ path: 'before', message: 'not a cursor' }]);
        }
        before = { createdAt, id: query.before.slice(at + 1) };
      }
      const orders = await deps.orders.page(userId, {
        ...(query.market === undefined ? {} : { symbol: query.market }),
        limit: query.limit,
        openOnly: query.status === 'open',
        ...(before ? { before } : {}),
      });
      const last = orders[orders.length - 1];
      return {
        orders: orders.map(toOrderView),
        // A history that cannot return the rest is one that silently ends.
        nextBefore:
          orders.length === query.limit && last
            ? `${String(last.createdAt.getTime())}.${last.id}`
            : null,
      };
    },

    async get(request) {
      requireTradingCluster(request);
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      return { order: toOrderView(await deps.orders.get(userId, id)) };
    },

    async cancel(request) {
      requireTradingCluster(request);
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      return { order: toOrderView(await deps.orders.cancel(userId, id, request.correlationId)) };
    },

    async cancelAll(request) {
      requireTradingCluster(request);
      const { userId } = requireSessionRecord(request);
      const { market } = request.query as { market: string };
      const orders = await deps.orders.cancelAll(userId, market, request.correlationId);
      return { orders: orders.map(toOrderView) };
    },

    async amend(request) {
      requireTradingCluster(request);
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      const body = request.body as { clientOrderId: string; price: string; qty: string };
      const order = await deps.orders.amend({
        userId,
        orderId: id,
        clientOrderId: body.clientOrderId,
        price: body.price,
        qty: body.qty,
        correlationId: request.correlationId,
      });
      return { order: toOrderView(order) };
    },

    async allocate(request) {
      requireTradingCluster(request);
      const { userId } = requireSessionRecord(request);
      const body = request.body as { asset: string; amount: string; idempotencyKey: string };
      const withdrawal = await deps.withdrawals.requestInternal({
        userId,
        asset: ledgerAssetKey(deps.cluster, body.asset),
        amount: body.amount,
        idempotencyKey: body.idempotencyKey,
        correlationId: request.correlationId,
        purpose: 'allocation',
        // Configuration, never the request: the body has no destination field.
        destination: deps.clearingAddress,
      });
      return { withdrawal: renderWithdrawal(deps.assets, withdrawal) };
    },

    async deallocate(request) {
      requireTradingCluster(request);
      const { userId } = requireSessionRecord(request);
      const body = request.body as { asset: string; amount: string; idempotencyKey: string };
      const withdrawal = await deps.withdrawals.requestInternal({
        userId,
        asset: ledgerAssetKey(deps.cluster, body.asset),
        amount: body.amount,
        idempotencyKey: body.idempotencyKey,
        correlationId: request.correlationId,
        purpose: 'deallocation',
        destination: await ownAddress(userId),
      });
      return { withdrawal: renderWithdrawal(deps.assets, withdrawal) };
    },
  };
}
