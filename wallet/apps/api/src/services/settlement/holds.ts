import { createSettlementRepository, type Executor, type OrderRecord } from '@wallet/db';
import { postOrderRelease } from '@wallet/ledger';
import { postLedger } from '../trading/ledger-post.js';

/**
 * The ONE way a hold is released (ADR-0034 §§2, 6).
 *
 * Every terminal path — the settlement worker on a terminal event, the gateway
 * on a business rejection or a full-quantity cancel, the sweeper on FAILED —
 * comes through here, so every one of them releases the same number: the
 * order's OUTSTANDING hold, derived from the ledger and the fills table. Never
 * `hold_amount`, which is what was posted, not what is left.
 *
 * The caller must already have WON the order's guarded transition to a
 * terminal status in the same transaction. That is what makes a second caller
 * find nothing to do; the partial unique index on `order_release` is the
 * backstop if two ever race from different states.
 */

/** The ledger and the order disagree. A settlement bug, and a halt. */
export class HoldInvariantError extends Error {
  constructor(readonly reason: string) {
    super(`hold invariant violated: ${reason}`);
    this.name = 'HoldInvariantError';
  }
}

export interface ReleaseOptions {
  /**
   * Assert the order was NEVER FILLED: its outstanding hold must equal what
   * was posted. The gateway's paths set this, because each of them releases
   * on the strength of an engine response that proves no fill happened — and
   * this assertion is the proof that it was right.
   */
  readonly requireUnfilled?: boolean;
}

/** Release whatever is still held. Returns the amount released (0n if none). */
export async function releaseOutstanding(
  tx: Executor,
  order: OrderRecord,
  options: ReleaseOptions = {},
): Promise<bigint> {
  const outstanding = await createSettlementRepository(tx).outstandingHold(order.id, tx);
  if (outstanding === null) throw new HoldInvariantError('order_not_found');
  if (outstanding < 0n) throw new HoldInvariantError('outstanding_negative');
  if (options.requireUnfilled && outstanding !== BigInt(order.holdAmount)) {
    throw new HoldInvariantError('released_as_unfilled_but_consumed');
  }
  // A fully consumed hold has nothing to return, and the ledger refuses a
  // zero entry. The order still becomes terminal (prompt_phase_s4.md rule 62b).
  if (outstanding === 0n) return 0n;

  await postLedger(
    tx,
    postOrderRelease({
      orderId: order.id,
      userId: order.userId,
      asset: order.holdAsset,
      amount: outstanding,
    }),
  );
  return outstanding;
}
