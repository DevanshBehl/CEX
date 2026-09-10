/**
 * Branded primitives (prompt_phase1.md rules 51-53).
 *
 * A brand is erased at runtime but prevents a bare string flowing into a slot
 * that means something specific. The payoff is Phase 2: `BaseUnits` cannot be
 * assigned from a JavaScript `number`, which is the class of bug that produces
 * silent rounding in a ledger.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type CredentialId = Brand<string, 'CredentialId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

export const asUserId = (v: string): UserId => v as UserId;
export const asSessionId = (v: string): SessionId => v as SessionId;
export const asCredentialId = (v: string): CredentialId => v as CredentialId;
export const asCorrelationId = (v: string): CorrelationId => v as CorrelationId;
