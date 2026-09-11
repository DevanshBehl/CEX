/**
 * Chain-agnostic vocabulary (prompt_phase2.md rules 91-100).
 *
 * NOTHING IN THIS PACKAGE MAY NAME A CHAIN.
 *
 * No lamport, no slot, no mint, no SPL, no Solana. Not in a type, not in a
 * field name, not in an example in a comment. This is the seam master-prompt
 * rule 196 depends on — "when adding chains, preserve the same ledger, risk,
 * authorization, and custody abstractions" — and a leak here is not a style
 * problem, it is a rewrite when the second chain arrives.
 *
 * Where a chain genuinely needs to carry something extra, it goes in the
 * opaque `metadata` field, which the domain never inspects.
 */

export type ChainId = string;

/** An address as the chain represents it textually. Validated, not merely typed. */
export type Address = string;

/** A chain's native reference for a transaction. */
export type TxReference = string;

/**
 * Monotonic chain position — Solana's slot, Ethereum's block number, Bitcoin's
 * height. Named for what it does rather than what any one chain calls it.
 */
export type ChainPosition = bigint;

/**
 * How settled a thing is, from the domain's point of view.
 *
 * Three levels, because that is the shape every chain the ledger cares about
 * actually has: seen, probably-permanent, and permanent. The mapping onto a
 * chain's own vocabulary lives in its adapter.
 */
export type Confirmation = 'seen' | 'probable' | 'final';

/**
 * The confirmation level at which a transfer may be credited
 * (prompt_phase2.md rule 97, ADR-0006).
 *
 * A named, configured value rather than a literal scattered through an adapter,
 * so it cannot be strict in one code path and lax in another.
 */
export interface ConfirmationPolicy {
  readonly creditAt: Confirmation;
  /** How long to wait before treating a pending transfer as worth re-checking. */
  readonly pollIntervalMs: number;
}

/**
 * A normalized incoming transfer (prompt_phase2.md rule 94).
 *
 * `instructionIndex` exists because one transaction may contain several
 * transfers to the same address, and each is a separate deposit. Without it the
 * uniqueness key collapses and the second transfer is silently swallowed as a
 * duplicate (rules 112, 127).
 */
export interface TransferEvent {
  readonly chain: ChainId;
  readonly asset: string;
  /** Base units, as a decimal string. Never a number. */
  readonly amount: string;
  readonly to: Address;
  readonly from: Address | null;
  readonly txReference: TxReference;
  readonly instructionIndex: number;
  readonly position: ChainPosition;
  readonly confirmation: Confirmation;
  /**
   * Chain-specific detail the domain never reads. This field is what keeps the
   * rest of the interface honest: when a chain needs something extra, it goes
   * here rather than widening the shared type (rule 100).
   */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A page of transfers plus the cursor to resume from. */
export interface TransferPage {
  readonly transfers: readonly TransferEvent[];
  /**
   * Opaque to the caller. Persisted only after the page has been fully
   * committed, so a restart re-reads rather than skips (rules 146-147).
   */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface FetchTransfersRequest {
  readonly address: Address;
  /**
   * Opaque cursor from a previous `TransferPage`, or null to start from the
   * beginning of the address's history.
   */
  readonly cursor: string | null;
  /** Maximum transfers to return. The adapter may return fewer. */
  readonly pageSize: number;
}
