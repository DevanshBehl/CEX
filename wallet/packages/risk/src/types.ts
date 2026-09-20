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
  /**
   * What this withdrawal is worth, in micro-dollars (10^-6 USD), from the most
   * recent recorded price — supplied by the caller, like every other input.
   *
   * `null` means the caller tried and could not price it (no feed, no recent
   * tick). Absent means the caller did not try. The USD review rule treats
   * the two differently: an unpriced withdrawal cannot be shown to be small.
   */
  readonly valueUsdMicros?: bigint | null;
  readonly now: Date;
}

export type DestinationCheck =
  | { readonly ok: true; readonly isPlatformOwned: boolean }
  | { readonly ok: false; readonly reason: 'invalid' | 'not_signable' };

/**
 * Value limits for ONE asset (prompt_phase4.md rule 127).
 *
 * Limits are denominated in an asset's own base units, and base units mean
 * different things per asset: 1 SOL is 10^9 lamports, 1 USDC is 10^6. A single
 * number applied to both is wrong by three orders of magnitude — and wrong in
 * the dangerous direction, because the SOL-shaped number is the larger one.
 */
export interface AssetLimits {
  readonly perTransactionLimit: Amount;
  readonly dailyLimit: Amount;
  readonly manualReviewAbove: Amount;
}

export interface RiskPolicy {
  readonly supportedAssets: readonly string[];
  /**
   * Per-asset limits, keyed by ledger asset key (`SOL`, or a mint address).
   *
   * An asset absent from this map has NO limits, and a withdrawal of it is
   * denied rather than falling back to another asset's numbers. Failing closed
   * is the whole point: an allowlisted mint with no configured limits is a
   * configuration gap, and the safe reading of a gap is zero, not "whatever
   * SOL uses".
   */
  readonly assetLimits: Readonly<Record<string, AssetLimits>>;
  /** @deprecated Native-asset limits. Kept so existing callers still compile. */
  readonly perTransactionLimit: Amount;
  readonly dailyLimit: Amount;
  readonly velocityWindowMinutes: number;
  readonly velocityMaxCount: number;
  readonly manualReviewAbove: Amount;
  readonly reviewNewDestinations: boolean;
  /**
   * Value-based review (ADR-0024): a withdrawal worth MORE than this many
   * micro-dollars goes to a person; everything under it that passes the hard
   * checks is approved automatically.
   *
   * When set, it REPLACES the per-asset base-unit review thresholds — one
   * dollar figure across every asset, rather than a SOL number and a USDC
   * number that drift apart as prices move. `null` or absent keeps the
   * base-unit thresholds.
   */
  readonly manualReviewAboveUsdMicros?: bigint | null;
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
