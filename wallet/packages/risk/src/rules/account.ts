import type { Rule } from '../types.js';

/**
 * A suspended or closed account cannot withdraw, whatever the amount
 * (prompt_phase3.md rule 90).
 *
 * Evaluated first, and still evaluated alongside everything else — the engine
 * does not short-circuit, so a suspended account attempting an over-limit
 * withdrawal produces both codes. An operator reviewing the case sees the whole
 * picture rather than the first thing that failed.
 */
export const accountStateRule: Rule = (input) => {
  if (input.accountStatus !== 'active') {
    return {
      rule: 'account_state',
      verdict: 'deny',
      codes: ['ACCOUNT_NOT_ACTIVE'],
      detail: { status: input.accountStatus },
    };
  }
  return { rule: 'account_state', verdict: 'approve', codes: [] };
};
