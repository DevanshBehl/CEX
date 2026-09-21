/**
 * The order state machine (prompt_phase_s3.md §10).
 *
 * Declared ONCE, here, and enforced twice — by the type system for code that
 * goes through the domain, and by a database trigger for everything else — in
 * exactly the way `withdrawal-states.ts` does it. The trigger's legal pairs are
 * checked against `allOrderTransitions()` in CI, so the two cannot drift.
 *
 * Helpers are prefixed (`canOrderTransition`, not `canTransition`) because both
 * machines are exported from the same barrel.
 */

export const ORDER_STATUSES = [
  /**
   * The hold is posted and the order row exists; the engine has not confirmed.
   *
   * An order can be stuck here for two different reasons, and they must not be
   * confused: the gateway died before calling the engine, OR the engine
   * accepted the command and could not confirm publication (a 503, ADR-0030).
   * The second has MATCHED. Only the journal-backed lookup can tell them apart.
   */
  'PENDING_ENGINE',
  'OPEN',
  'PARTIALLY_FILLED',
  /** A cancel was sent. It may still lose to a fill. */
  'PENDING_CANCEL',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  /** The sweeper established the engine never received it. */
  'FAILED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_ENGINE: ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'EXPIRED', 'FAILED'],
  OPEN: ['PARTIALLY_FILLED', 'FILLED', 'PENDING_CANCEL', 'EXPIRED'],
  PARTIALLY_FILLED: ['FILLED', 'PENDING_CANCEL', 'EXPIRED'],
  // A cancel races a fill, and the fill wins. Modelled, not treated as an error.
  PENDING_CANCEL: ['CANCELLED', 'FILLED', 'PARTIALLY_FILLED'],

  // Terminal.
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
  EXPIRED: [],
  FAILED: [],
};

export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'FAILED',
]);

/**
 * States in which the order holds funds in `user_order_locked`.
 *
 * Exists so the ledger and the machine can be asserted to agree: an order in
 * one of these states has an outstanding hold, and one outside them has none.
 */
export const HOLDING_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'PENDING_ENGINE',
  'OPEN',
  'PARTIALLY_FILLED',
  'PENDING_CANCEL',
]);

export function canOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isTerminalOrder(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(status);
}

export function orderHoldsFunds(status: OrderStatus): boolean {
  return HOLDING_ORDER_STATUSES.has(status);
}

/** Every legal transition as a flat list — the input to the database trigger. */
export function allOrderTransitions(): Array<{ from: OrderStatus; to: OrderStatus }> {
  return ORDER_STATUSES.flatMap((from) => ORDER_TRANSITIONS[from].map((to) => ({ from, to })));
}
