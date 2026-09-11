/**
 * Branded primitives (prompt_phase1.md rules 51-53).
 *
 * A brand is erased at runtime but prevents a bare string flowing into a slot
 * that means something specific. The payoff is Phase 2: `BaseUnits` cannot be
 * assigned from a JavaScript `number`, which is the class of bug that produces
 * silent rounding in a ledger.
 */

/**
 * A phantom property rather than a `unique symbol`.
 *
 * `unique symbol` is the stricter encoding and was the first choice, but a
 * declaration that references one cannot be NAMED in an emitted .d.ts — every
 * schema built on a branded type then fails with TS4023 in any package that
 * re-exports it, and exporting the symbol does not help because the emitted
 * type still refers to it positionally.
 *
 * A literal-keyed phantom property is nameable, survives declaration emit, and
 * provides the property that matters: a bare `string` is not assignable to a
 * branded type, so an unvalidated value cannot reach a slot that requires a
 * validated one. It is forgeable by someone who writes the phantom key out
 * deliberately, which is a level of effort that is no longer an accident.
 *
 * The property never exists at runtime.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type CredentialId = Brand<string, 'CredentialId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

export const asUserId = (v: string): UserId => v as UserId;
export const asSessionId = (v: string): SessionId => v as SessionId;
export const asCredentialId = (v: string): CredentialId => v as CredentialId;
export const asCorrelationId = (v: string): CorrelationId => v as CorrelationId;
