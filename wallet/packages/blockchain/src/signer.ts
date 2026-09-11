/**
 * The MPC boundary (master-prompt rules 101-102, prompt_phase2.md rules 95-96).
 *
 * DECLARED HERE, IMPLEMENTED NOWHERE IN PHASE 2.
 *
 * Phase 2 only receives money, so nothing signs. This interface exists now for
 * one reason: `ChainAdapter` needs to describe how a transaction gets signed in
 * order to describe transactions at all, and a half-described adapter would
 * have to be reopened in Phase 3 anyway.
 *
 * Phase 3 supplies a clearly-labelled mock. Phase 4 replaces it with a Rust
 * threshold implementation. Neither may require a change above this line — if
 * a swap forces an edit to a caller, the abstraction leaked and that leak is
 * the bug (master-prompt rule 102).
 */

/**
 * An opaque handle to key material. The application never learns what it points
 * at, and this type deliberately carries no field that could reveal it
 * (master-prompt rules 99-100).
 */
export interface KeyRef {
  readonly id: string;
}

/**
 * Proof that a human or a policy authorised this signature, produced by a
 * system entirely separate from the one that signs (master-prompt rule 109).
 *
 * Authorising and signing are different concerns and, in Phase 4, different
 * processes. Passing the proof through the request rather than letting the
 * signer decide is what keeps them separable.
 */
export interface AuthorizationProof {
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly policyVersion: string;
  readonly reference: string;
}

export interface SignRequest {
  /**
   * Idempotency key. The same id must yield the same signature and must not
   * start a second signing round — under threshold signing, a duplicate round
   * is not merely wasteful, it is a nonce-reuse hazard.
   */
  readonly requestId: string;
  readonly keyRef: KeyRef;
  /** The exact bytes to sign. The signer does not parse them. */
  readonly payload: Uint8Array;
  readonly authorization: AuthorizationProof;
}

export interface SignResult {
  readonly requestId: string;
  readonly signature: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface Signer {
  getPublicKey(keyRef: KeyRef): Promise<Uint8Array>;
  sign(request: SignRequest): Promise<SignResult>;
}
