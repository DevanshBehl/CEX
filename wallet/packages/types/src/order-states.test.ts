import { describe, expect, it } from 'vitest';
import {
  allOrderTransitions,
  canOrderTransition,
  HOLDING_ORDER_STATUSES,
  isTerminalOrder,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
} from './order-states.js';

describe('the order state machine', () => {
  it('declares a transition list for every status', () => {
    for (const status of ORDER_STATUSES) expect(ORDER_TRANSITIONS[status]).toBeDefined();
  });

  it('only ever transitions to statuses that exist', () => {
    for (const { to } of allOrderTransitions()) expect(ORDER_STATUSES).toContain(to);
  });

  it('terminal states have no exits, and every state with no exits is terminal', () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS[status].length === 0, status).toBe(isTerminalOrder(status));
    }
  });

  it('every state is reachable from PENDING_ENGINE', () => {
    const seen = new Set<string>(['PENDING_ENGINE']);
    const queue = ['PENDING_ENGINE'] as const as readonly string[];
    const work = [...queue];
    while (work.length > 0) {
      const next = work.pop() as (typeof ORDER_STATUSES)[number];
      for (const to of ORDER_TRANSITIONS[next]) {
        if (!seen.has(to)) {
          seen.add(to);
          work.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  // A cancel races a fill and the fill wins.
  it('lets a pending cancel end in a fill', () => {
    expect(canOrderTransition('PENDING_CANCEL', 'FILLED')).toBe(true);
    expect(canOrderTransition('PENDING_CANCEL', 'CANCELLED')).toBe(true);
  });

  // A 503 is ambiguous: the order may already have matched, so the sweeper
  // must be able to move it straight to a filled state once the lookup says so.
  it('lets PENDING_ENGINE resolve to any outcome the engine can report', () => {
    for (const to of ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'EXPIRED'] as const) {
      expect(canOrderTransition('PENDING_ENGINE', to), to).toBe(true);
    }
  });

  it('never leaves a terminal state', () => {
    for (const from of TERMINAL_ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) expect(canOrderTransition(from, to)).toBe(false);
    }
  });

  it('holds funds exactly in the non-terminal states', () => {
    for (const status of ORDER_STATUSES) {
      expect(HOLDING_ORDER_STATUSES.has(status), status).toBe(!isTerminalOrder(status));
    }
  });
});
