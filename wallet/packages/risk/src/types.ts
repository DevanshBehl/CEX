import type { ReasonCode } from './reason-codes.js';

/**
 * The policy engine's vocabulary (prompt_phase3.md rules 71-74).
 *
 * Everything the engine needs is an argument. There is no database access, no
 * clock, no configuration read, and no chain — so the same input always
 * produces the same decision, and a decision persisted years ago can be
 * replayed to explain itself (master-prompt rule 153).
 */

export type Verdict = 'approve' | 'deny' | 'review';

/**
 * Amounts are `bigint` base units, matching the ledger.
 *
 * Never `number`: a policy engine comparing lamports against a limit is exactly
 * where a silently-rounded comparison would let a withdrawal through.
 */
export type Amount = bigint;

/** A destination the account has sent to before, and when. */
export interface PriorDestination {
  readonly address: string;
  readonly lastUsedAt: Date;
}

/** One previously settled or in-flight withdrawal, for the rolling windows. */
export interface WithdrawalHistoryEntry {
  readonly amount: Amount;
  readonly asset: string;
  readonly createdAt: Date;
}

/**
 * Everything the engine evaluates against.
 *
 * `now` is an argument and never `Date.now()` (rule 74). A velocity window that
 * reads the clock cannot be tested at a boundary and cannot be replayed.
 */
export interface RiskInput {
  readonly userId: string;
  readonly accountStatus: 'active' | 'suspended' | 'closed';
  readonly asset: string;
  readonly amount: Amount;
  readonly destination: string;
  /**
   * Whether the destination is well-formed and spendable, decided by the chain
   * adapter. The engine is chain-free, so it receives the verdict rather than
   * computing it.
   */
  readonly destinationCheck: DestinationCheck;
  readonly priorDestinations: readonly PriorDestination[];
  /** Withdrawals in the trailing window, supplied by the caller. */
  readonly recentWithdrawals: readonly WithdrawalHistoryEntry[];
  readonly now: Date;
}

export type DestinationCheck =
  | { readonly ok: true; readonly isPlatformOwned: boolean }
  | { readonly ok: false; readonly reason: 'invalid' | 'not_signable' };

export interface RiskPolicy {
  readonly supportedAssets: readonly string[];
  readonly perTransactionLimit: Amount;
  readonly dailyLimit: Amount;
  readonly velocityWindowMinutes: number;
  readonly velocityMaxCount: number;
  readonly manualReviewAbove: Amount;
  readonly reviewNewDestinations: boolean;
  /** How far back a destination counts as "known". */
  readonly knownDestinationWindowDays: number;
}

/**
 * The outcome of one rule.
 *
 * A rule never denies and reviews at once; the composer resolves precedence.
 */
export interface RuleOutcome {
  readonly rule: string;
  readonly verdict: Verdict;
  readonly codes: readonly ReasonCode[];
  /**
   * Numbers an OPERATOR may see. Never returned to the client (rules 81-82).
   * String-valued so a bigint survives JSON.
   */
  readonly detail?: Readonly<Record<string, string>>;
}

/**
 * The persisted, replayable decision.
 *
 * `evaluatedRules` records every rule that ran, not only the ones that
 * complained, so "was the daily limit checked?" is answerable from the record
 * rather than from the code as it exists today.
 */
export interface RiskDecision {
  readonly verdict: Verdict;
  readonly codes: readonly ReasonCode[];
  readonly outcomes: readonly RuleOutcome[];
  readonly evaluatedRules: readonly string[];
  readonly policyVersion: string;
  readonly evaluatedAt: Date;
}

export type Rule = (input: RiskInput, policy: RiskPolicy) => RuleOutcome;
