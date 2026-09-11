import { createHash, sign as edSign, type KeyObject } from 'node:crypto';
import type { AuthorizationProof } from './signer.js';

/**
 * Signing an authorization proof (ADR-0015).
 *
 * WHY THIS EXISTS
 *
 * Until now the proof was a claim: a struct saying "the risk engine approved
 * this". The signing service checked it was well-formed and signed. That
 * protects key material and nothing else — a compromised API could fabricate a
 * proof and have funds signed away without ever touching the key.
 *
 * Signing the proof turns the claim into evidence. The approval key lives
 * separately from the caller key, so compromising the caller lets an attacker
 * ASK for signatures, and this is what stops asking from being enough.
 *
 * In 4b each of the five participants verifies this independently, which is
 * what stops a compromised coordinator (prompt_phase4.md rules 93–97).
 */

/**
 * The exact bytes the approval authority signs.
 *
 * It binds the proof to **this payload**, which is the property that matters:
 * without the payload hash a proof issued for one withdrawal could be replayed
 * onto another.
 *
 * `services/mpc/src/signer.rs::authorization_message` pins the same format. If
 * the two disagree every signing request is refused — a far better failure than
 * the alternative, and the cross-language test is where it surfaces.
 */
export function authorizationMessage(
  proof: Omit<AuthorizationProof, 'signature'>,
  payload: Uint8Array,
): string {
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  return [
    proof.approvedBy,
    proof.approvedAt,
    proof.policyVersion,
    proof.reference,
    payloadHash,
  ].join('\n');
}

/**
 * Sign a proof so the signing service will accept it.
 *
 * The key belongs to the approval authority — conceptually the risk engine —
 * and is deliberately NOT the key used to authenticate to the MPC service.
 */
export function signAuthorization(
  proof: Omit<AuthorizationProof, 'signature'>,
  payload: Uint8Array,
  approvalKey: KeyObject,
): AuthorizationProof {
  // Ed25519 in Node takes a null algorithm — the scheme prehashes internally.
  const signature = edSign(null, Buffer.from(authorizationMessage(proof, payload)), approvalKey);
  return { ...proof, signature: signature.toString('base64') };
}
