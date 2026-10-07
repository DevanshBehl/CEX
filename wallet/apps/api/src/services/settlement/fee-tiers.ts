import { createSettlementRepository, type Executor } from '@wallet/db';
import { tierForVolume } from '@wallet/orders';

/**
 * A user's fee rates for a fill (ADR-0034 §9).
 *
 * Fixed per user, quote asset and UTC DAY, from quote volume in fills whose
 * engine timestamp falls in the 30 days before that day's 00:00 UTC. Written
 * once, the first time any market needs it, and never recomputed.
 *
 * Not a rolling window ending at the fill. Fill timestamps are gateway-signed
 * and only bounded by the engine's tolerance window, so they are not monotonic
 * in sequence order, and each market settles on its own worker. "The fills
 * before this one" would depend on which worker ran first. A snapshot depends
 * only on what was recorded when it was written, and is then itself recorded.
 *
 * `now()` appears nowhere in here. A fee that depended on when settlement ran
 * could not be recomputed later and come out the same.
 */

export interface FeeRates {
  readonly tier: number;
  readonly makerBps: number;
  readonly takerBps: number;
}

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;

/** The UTC day a timestamp falls on, as `YYYY-MM-DD`. */
export function utcDay(timestampMs: bigint): string {
  const ms = Number(timestampMs);
  if (!Number.isSafeInteger(ms)) throw new RangeError('fill timestamp out of range');
  return new Date(ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS)).toISOString().slice(0, 10);
}

export async function feeRatesFor(
  tx: Executor,
  input: { readonly userId: string; readonly quoteAsset: string; readonly timestampMs: bigint },
): Promise<FeeRates> {
  const repo = createSettlementRepository(tx);
  const day = utcDay(input.timestampMs);

  const existing = await repo.findTierSnapshot(input.userId, input.quoteAsset, day, tx);
  if (existing) return existing;

  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const windowStart = new Date(dayStart.getTime() - WINDOW_DAYS * DAY_MS);
  const volume = await repo.quoteVolume(input.userId, input.quoteAsset, windowStart, dayStart, tx);
  const tier = tierForVolume(volume);

  // First writer wins; a concurrent writer's snapshot is the one returned.
  return repo.insertTierSnapshot(
    {
      userId: input.userId,
      quoteAsset: input.quoteAsset,
      day,
      volume,
      tier: tier.tier,
      makerBps: tier.makerBps,
      takerBps: tier.takerBps,
    },
    tx,
  );
}
