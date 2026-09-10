/**
 * Signature-counter clone detection (prompt_phase1.md rules 114-115).
 *
 * A pure predicate rather than an inline `if`, because it is a security
 * decision with a subtle rule and it deserves to be tested directly rather
 * than only through a full ceremony.
 *
 * The WebAuthn signature counter is meant to increase on every assertion. If a
 * counter that has previously advanced stops advancing, the likeliest
 * explanation is that the credential's private key has been extracted and now
 * exists in two places — the legitimate authenticator and a copy.
 *
 * The exception that makes this subtle: a counter of 0 means "this
 * authenticator does not implement a counter at all". That is common and
 * entirely normal — most platform authenticators, including iCloud Keychain
 * and other synced passkey providers, report 0 forever, precisely because the
 * credential legitimately exists on several devices. Treating a stored 0 as
 * suspicious would lock out a large share of real users on their second login.
 *
 * So: only a previously-advancing counter that fails to advance is a signal.
 */
export type CloneVerdict =
  | { readonly suspicious: false }
  | { readonly suspicious: true; readonly reason: 'sign_count_did_not_advance' };

export function detectClone(storedSignCount: bigint, receivedSignCount: bigint): CloneVerdict {
  // Authenticator does not implement a counter — no signal either way.
  if (storedSignCount === 0n) return { suspicious: false };

  if (receivedSignCount > storedSignCount) return { suspicious: false };

  return { suspicious: true, reason: 'sign_count_did_not_advance' };
}
