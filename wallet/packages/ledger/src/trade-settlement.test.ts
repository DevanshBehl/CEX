import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { feeAmount, notional } from '@wallet/types';
import {
  accountKey,
  checkAllInvariants,
  clearingAssets,
  houseTradingFees,
  InvalidEntryError,
  isBalanced,
  postAllocation,
  postDeposit,
  postOrderHold,
  postOrderRelease,
  postTradeSettlement,
  postWithdrawalLock,
  projectAll,
  signedAmount,
  userOrderLocked,
  userTradingAvailable,
  type AccountRef,
  type Entry,
} from './index.js';

const BASE = 'devnet:SOL';
const QUOTE = 'devnet:USDC';

function balance(entries: readonly Entry[], ref: AccountRef): bigint {
  const projected = projectAll(entries).get(accountKey(ref));
  if (!projected) return 0n;
  const liability = ref.type.startsWith('user_') || ref.type.startsWith('house_');
  return liability ? -projected.balance : projected.balance;
}

/** A user with `amount` of `asset` in the trading tier, by the real path. */
function funded(userId: string, asset: string, amount: bigint, ref: string): Entry[] {
  return [
    ...postDeposit({ depositId: `d-${ref}`, userId, asset, amount }).entries,
    ...postWithdrawalLock({ withdrawalId: `a-${ref}`, userId, asset, amount }).entries,
    ...postAllocation({ withdrawalId: `a-${ref}`, userId, asset, amount }).entries,
  ];
}

const fill = (overrides: Partial<Parameters<typeof postTradeSettlement>[0]> = {}) =>
  postTradeSettlement({
    fillId: '7:0',
    buyerId: 'buyer',
    sellerId: 'seller',
    baseAsset: BASE,
    quoteAsset: QUOTE,
    qty: 2_000n,
    notional: 300_000n,
    buyerFee: 600n,
    sellerFee: 300n,
    ...overrides,
  });

describe('postTradeSettlement', () => {
  it('is one trade_settle transaction referenced by the FILL id', () => {
    const tx = fill();
    expect(tx.kind).toBe('trade_settle');
    expect(tx.referenceType).toBe('fill');
    expect(tx.referenceId).toBe('7:0');
  });

  it('balances each asset independently', () => {
    const tx = fill();
    expect(isBalanced(tx.entries)).toBe(true);
    for (const asset of [BASE, QUOTE]) {
      const residual = tx.entries
        .filter((e) => e.asset === asset)
        .reduce((s, e) => s + signedAmount(e), 0n);
      expect(residual, asset).toBe(0n);
    }
  });

  it('consumes both holds and credits each side what it bought', () => {
    const tx = fill();
    const e = tx.entries;
    expect(balance(e, userOrderLocked('buyer', QUOTE))).toBe(-(300_000n + 600n));
    expect(balance(e, userTradingAvailable('seller', QUOTE))).toBe(300_000n - 300n);
    expect(balance(e, userOrderLocked('seller', BASE))).toBe(-2_000n);
    expect(balance(e, userTradingAvailable('buyer', BASE))).toBe(2_000n);
  });

  it('sends both fees to house_trading_fees in the quote asset', () => {
    const tx = fill();
    expect(balance(tx.entries, houseTradingFees(QUOTE))).toBe(900n);
    expect(
      tx.entries.some((e) => e.account.type === 'house_trading_fees' && e.asset === BASE),
    ).toBe(false);
  });

  it('omits a zero fee leg rather than posting a zero entry', () => {
    const tx = fill({ buyerFee: 0n, sellerFee: 0n });
    expect(tx.entries.some((e) => e.account.type === 'house_trading_fees')).toBe(false);
    expect(isBalanced(tx.entries)).toBe(true);
  });

  it('settles a fill whose notional floored to zero on its base legs alone', () => {
    const tx = fill({ notional: 0n, buyerFee: 0n, sellerFee: 0n });
    expect(tx.entries.every((e) => e.asset === BASE)).toBe(true);
  });

  it('refuses arithmetic no market can produce', () => {
    expect(() => fill({ qty: 0n })).toThrow(InvalidEntryError);
    expect(() => fill({ buyerFee: -1n })).toThrow(InvalidEntryError);
    expect(() => fill({ sellerFee: 300_001n })).toThrow(InvalidEntryError);
    expect(() => fill({ quoteAsset: BASE })).toThrow(InvalidEntryError);
  });

  it('leaves the clearing address untouched: a trade moves liabilities, not coins', () => {
    const before = [
      ...funded('buyer', QUOTE, 1_000_000n, 'b'),
      ...funded('seller', BASE, 10_000n, 's'),
      ...postOrderHold({ orderId: 'ob', userId: 'buyer', asset: QUOTE, amount: 400_000n }).entries,
      ...postOrderHold({ orderId: 'os', userId: 'seller', asset: BASE, amount: 2_000n }).entries,
    ];
    const after = [...before, ...fill().entries];
    for (const asset of [BASE, QUOTE]) {
      expect(balance(after, clearingAssets(asset))).toBe(balance(before, clearingAssets(asset)));
    }
    expect(checkAllInvariants(after)).toEqual([]);
  });
});

/*
 * Rule 108: for any generated sequence of fills against held orders, both
 * tiers stay covered, no user trading balance goes negative, and quantity is
 * conserved between buyer and seller.
 */
describe('a sequence of fills against held orders', () => {
  const USERS = ['u0', 'u1', 'u2', 'u3'];
  const PRICE_SCALE = 1_000_000_000n;

  it('keeps every invariant, and conserves base quantity', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            buyer: fc.constantFrom(...USERS),
            seller: fc.constantFrom(...USERS),
            qty: fc.bigInt({ min: 1n, max: 1_000_000n }),
            price: fc.bigInt({ min: 1n, max: 500n * PRICE_SCALE }),
            takerBuys: fc.boolean(),
            takerBps: fc.constantFrom(10, 15, 18, 20),
            makerBps: fc.constantFrom(2, 5, 8, 10),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (fills) => {
          const entries: Entry[] = [];
          for (const u of USERS) {
            entries.push(...funded(u, QUOTE, 10n ** 15n, `${u}q`));
            entries.push(...funded(u, BASE, 10n ** 12n, `${u}b`));
          }

          fills.forEach((f, i) => {
            const value = notional(f.price, f.qty);
            const buyerBps = f.takerBuys ? f.takerBps : f.makerBps;
            const sellerBps = f.takerBuys ? f.makerBps : f.takerBps;
            const buyerFee = feeAmount(value, buyerBps);
            const sellerFee = feeAmount(value, sellerBps);
            // Each fill against its own exactly-sized holds, then settled, then
            // its holds' (zero) remainder is never released — a fully
            // consumed hold has nothing to return.
            const buyHold = value + buyerFee;
            if (buyHold > 0n) {
              entries.push(
                ...postOrderHold({
                  orderId: `b${i}`,
                  userId: f.buyer,
                  asset: QUOTE,
                  amount: buyHold,
                }).entries,
              );
            }
            entries.push(
              ...postOrderHold({ orderId: `s${i}`, userId: f.seller, asset: BASE, amount: f.qty })
                .entries,
            );
            entries.push(
              ...postTradeSettlement({
                fillId: `${i}:0`,
                buyerId: f.buyer,
                sellerId: f.seller,
                baseAsset: BASE,
                quoteAsset: QUOTE,
                qty: f.qty,
                notional: value,
                buyerFee,
                sellerFee,
              }).entries,
            );
          });

          expect(checkAllInvariants(entries)).toEqual([]);
          // Every hold was consumed exactly: nothing left locked.
          for (const u of USERS) {
            expect(balance(entries, userOrderLocked(u, BASE))).toBe(0n);
            expect(balance(entries, userOrderLocked(u, QUOTE))).toBe(0n);
          }
          // Base is conserved: what sellers gave, buyers got.
          const totalBase = USERS.reduce(
            (s, u) => s + balance(entries, userTradingAvailable(u, BASE)),
            0n,
          );
          expect(totalBase).toBe(BigInt(USERS.length) * 10n ** 12n);
          // Quote is conserved up to the fees, which went to the house.
          const totalQuote = USERS.reduce(
            (s, u) => s + balance(entries, userTradingAvailable(u, QUOTE)),
            0n,
          );
          expect(totalQuote + balance(entries, houseTradingFees(QUOTE))).toBe(
            BigInt(USERS.length) * 10n ** 15n,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a partial fill leaves the remainder held until one release returns it', () => {
    const entries = [
      ...funded('buyer', QUOTE, 1_000_000n, 'b'),
      ...funded('seller', BASE, 10_000n, 's'),
      ...postOrderHold({ orderId: 'ob', userId: 'buyer', asset: QUOTE, amount: 700_000n }).entries,
      ...postOrderHold({ orderId: 'os', userId: 'seller', asset: BASE, amount: 2_000n }).entries,
      ...fill().entries,
    ];
    // 700 000 held, 300 600 consumed: 399 400 still reserved.
    expect(balance(entries, userOrderLocked('buyer', QUOTE))).toBe(399_400n);
    const released = [
      ...entries,
      ...postOrderRelease({ orderId: 'ob', userId: 'buyer', asset: QUOTE, amount: 399_400n })
        .entries,
    ];
    expect(balance(released, userOrderLocked('buyer', QUOTE))).toBe(0n);
    expect(balance(released, userTradingAvailable('buyer', QUOTE))).toBe(1_000_000n - 300_600n);
    expect(checkAllInvariants(released)).toEqual([]);
  });
});
