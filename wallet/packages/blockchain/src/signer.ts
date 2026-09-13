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
import type { CustodyTier } from './custody.js';

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
  /**
   * Which custody tier this movement is from (ADR-0018).
   *
   * The signing boundary derives the tier's authority requirements from this
   * and refuses a proof that does not carry them. Absent means the default
   * tier, which is the working float — the tier every withdrawal came from
   * before tiers existed.
   */
  readonly tier?: CustodyTier;
  /**
   * base64 Ed25519 signature by the approval authority, over the proof bound
   * to the payload hash (see `signAuthorization`).
   *
   * Optional in the type so a development deployment without an approval key
   * still type-checks; the signing service REQUIRES it whenever one is
   * configured, and warns on every request when one is not.
   */
  readonly signature?: string;
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

/**
 * A key that exists because it was provisioned, not because it was derived.
 *
 * Under segregated custody (ADR-0020) each user's address is its own threshold
 * group, and the address IS the group's verifying key. There is no seed and no
 * index — so creating an address becomes a distributed operation that can fail,
 * rather than a pure function.
 */
export interface ProvisionedKey {
  readonly keyRef: string;
  /** base58. The group verifying key, which is the address itself. */
  readonly address: string;
  readonly threshold: number;
  readonly participants: number;
  /** True when this key already existed and was returned unchanged. */
  readonly existing: boolean;
}

/**
 * Creates per-user threshold keys.
 *
 * Separate from `Signer` on purpose: signing is on the hot path of every
 * withdrawal, provisioning happens once per user, and a deployment can have a
 * signer without a coordinator (the single-key service). Folding the two
 * together would make every signer owe an implementation of an operation most
 * of them cannot perform.
 *
 * MUST be idempotent for a given `keyRef`: a retried signup must return the
 * same address, never mint a second key. The address may already be published
 * and already funded, and replacing it strands whatever is there.
 */
export interface KeyProvisioner {
  provisionKey(keyRef: KeyRef): Promise<ProvisionedKey>;
}
