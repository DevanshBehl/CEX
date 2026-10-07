import { computeHold, FEE_TIERS, validateOrder } from '@wallet/orders';
import {
  createMarket,
  feeAmount,
  ledgerAssetKey,
  parseDecimal,
  parseHumanPrice,
  priceFromBigInt,
  qtyFromBigInt,
  type Cluster,
  type MarketView,
  type OrderRequest,
  type RejectReason,
} from '@wallet/types';

/**
 * What a person typed into the order form, as the order the gateway takes
 * (prompt_phase_s5.md rules 149-153).
 *
 * Pure: text in, a request and the numbers to show beside it out. The price
 * and quantity are parsed from their decimal strings to scaled integers
 * without a float, the order is checked with the SAME `validateOrder` the
 * server runs, and the hold shown is the SAME `computeHold` the gateway will
 * take. The server validates again and its answer is the one that counts; this
 * exists so a person is told what is wrong before they submit, not after.
 */

export interface DraftInput {
  readonly cluster: Cluster;
  readonly market: MarketView;
  readonly side: 'buy' | 'sell';
  readonly type: 'limit' | 'market';
  readonly timeInForce: 'GTC' | 'IOC' | 'FOK';
  readonly postOnly: boolean;
  /** As typed. Ignored for a market order. */
  readonly price: string;
  readonly qty: string;
  /**
   * What the collar is centred on: the last trade, else the mid, else null.
   * An ESTIMATE of the engine's own reference — the server uses the engine's.
   */
  readonly reference: bigint | null;
}

export type Draft =
  | {
      readonly ok: true;
      readonly body: {
        readonly market: string;
        readonly side: 'buy' | 'sell';
        readonly type: 'limit' | 'market';
        readonly timeInForce: 'GTC' | 'IOC' | 'FOK';
        readonly price: string | null;
        readonly qty: string;
        readonly postOnly: boolean;
      };
      /** What will be reserved, and in which asset. Exactly the gateway's figure. */
      readonly hold: { readonly asset: 'base' | 'quote'; readonly amount: bigint };
      /** The worst-case fee inside a buy's hold. Zero for a sell. */
      readonly feeHeadroom: bigint;
      /** The order's value at its own price — or at the collar top for a market buy. */
      readonly notional: bigint | null;
      /** An ESTIMATE, at the entry tier's taker rate. Labelled as one. */
      readonly estimatedFee: bigint | null;
    }
  | { readonly ok: false; readonly errors: readonly string[] };

const MESSAGES: Partial<Record<RejectReason, string>> = {
  MARKET_NOT_OPEN: 'This market is not accepting orders right now.',
  QUANTITY_NOT_POSITIVE: 'Enter a quantity greater than zero.',
  PRICE_REQUIRED: 'A limit order needs a price.',
  TICK_VIOLATION: 'That price is not on this market’s tick.',
  LOT_VIOLATION: 'That quantity is not a whole number of lots.',
  NO_REFERENCE_PRICE: 'This market has no reference price yet, so a market order cannot be sized.',
  OUTSIDE_COLLAR: 'That price is too far from the market to be accepted.',
  BELOW_MIN_NOTIONAL: 'This order is below the market’s minimum size.',
  NOTIONAL_OVERFLOW: 'This order is too large.',
  POST_ONLY_REQUIRES_LIMIT: 'Post-only applies to limit orders.',
  PRICE_NOT_ALLOWED: 'A market order has no price.',
};

const PARSE_MESSAGES = {
  empty: 'is required.',
  malformed: 'must be a number, with no signs or separators.',
  too_precise: 'has more decimal places than this market allows.',
  too_large: 'is too large.',
} as const;

export function draftOrder(input: DraftInput): Draft {
  const { market } = input;
  const errors: string[] = [];

  const qty = parseDecimal(input.qty, market.baseDecimals);
  if (!qty.ok) errors.push(`Quantity ${PARSE_MESSAGES[qty.reason]}`);

  let price: bigint | null = null;
  if (input.type === 'limit') {
    const parsed = parseHumanPrice(input.price, market);
    if (!parsed.ok) errors.push(`Price ${PARSE_MESSAGES[parsed.reason]}`);
    else price = parsed.value;
  }
  if (!qty.ok || errors.length > 0) return { ok: false, errors };

  const domain = createMarket({
    cluster: input.cluster,
    symbol: market.symbol,
    baseAsset: ledgerAssetKey(input.cluster, market.baseAsset),
    quoteAsset: ledgerAssetKey(input.cluster, market.quoteAsset),
    tickSize: market.tickSize,
    lotSize: market.lotSize,
    minNotional: market.minNotional,
    collarBps: market.collarBps,
    status: market.status,
  });
  const request: OrderRequest = {
    // Not sent: the form's caller supplies ONE id per intent (rule 152).
    clientOrderId: '',
    market: domain.id,
    side: input.side,
    type: input.type,
    timeInForce: input.type === 'market' ? 'IOC' : input.timeInForce,
    price: price === null ? null : priceFromBigInt(price),
    qty: qtyFromBigInt(qty.value),
    postOnly: input.type === 'limit' && input.postOnly,
    stpMode: 'cancel_taker',
    accountId: '',
  };

  const verdict = validateOrder({ request, market: domain, reference: input.reference });
  if (!verdict.ok) {
    return {
      ok: false,
      errors: [...new Set(verdict.reasons)].map(
        (reason) => MESSAGES[reason] ?? 'This order cannot be placed as entered.',
      ),
    };
  }

  const hold = computeHold({ request, market: domain, reference: input.reference });
  const entryTier = FEE_TIERS[0]!;
  return {
    ok: true,
    body: {
      market: market.symbol,
      side: request.side,
      type: request.type,
      timeInForce: request.timeInForce,
      price: request.price,
      qty: request.qty,
      postOnly: request.postOnly,
    },
    hold: { asset: input.side === 'buy' ? 'quote' : 'base', amount: hold.amount },
    feeHeadroom: hold.feeHeadroom,
    notional: verdict.notional,
    estimatedFee:
      verdict.notional === null ? null : feeAmount(verdict.notional, entryTier.takerBps),
  };
}
