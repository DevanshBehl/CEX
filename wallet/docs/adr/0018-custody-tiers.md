# ADR-0018: Tiers are defined by their signing policy, not by their label

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 4

## Context

master-prompt rules 96–98 ask for hot, warm and cold custody roles. Phase 3
added the enum — `deposit | hot | warm | cold` — and no behaviour, which was the
honest thing to do at the time: there was one key and one signing path, so three
tiers would have been three names for it.

prompt_phase4.md rule 137 states the trap directly: **tiers that all sign the
same way are labels, not segregation.** An `enum` that three code paths ignore
provides the appearance of custody segregation to an auditor, an operator and a
reader of the schema, while providing none of it. That is worse than having no
tiers, because it is load-bearing in everyone's mental model and nowhere else.

So the question is not "what are the tiers" but "what makes two tiers
different", and the answer has to be something a compromised API cannot bypass.

## Decision

**A tier is defined by what it takes to move money out of it.**

| Tier        | Holds                     | Authorization required                 | Signing                                 | Online |
| ----------- | ------------------------- | -------------------------------------- | --------------------------------------- | ------ |
| **deposit** | one user's incoming funds | none — destination is fixed (ADR-0017) | single key, hardcoded destination       | yes    |
| **hot**     | working float             | risk engine's proof                    | automated threshold, 3-of-5             | yes    |
| **warm**    | buffer above hot ceiling  | risk engine **and** one human operator | threshold, 3-of-5, human proof required | yes    |
| **cold**    | reserve                   | two human operators, out of band       | threshold, offline ceremony             | no     |

The differences that matter are in the third and fourth columns. They are
enforced **in the signing boundary**, by participants that independently verify
the `AuthorizationProof` (ADR-0015) — not by a check in the API that a
compromised API could skip.

### The mechanism: the proof carries the tier, and the participant checks it

ADR-0015 already established that each participant verifies the authorization
proof against an approval key it holds independently of the coordinator. Tiers
extend that by one field:

```
AuthorizationProof {
  approvedBy      "risk-engine"                 <- hot
                  "risk-engine+operator:alice"  <- warm
                  "ceremony:2026-09-11"         <- cold
  policyVersion
  reference
  signature       <- over the proof bound to THIS payload hash
}
```

A participant holding warm-tier key material **refuses a proof signed only by
the risk engine.** Not because the API asked it to, but because its own
configuration says a warm movement requires an operator signature and it can
verify whether one is present.

This is what makes the tier real: the enforcement survives a compromised
coordinator. A tier check in `withdrawal.service.ts` does not.

### Authority is ordered, and requirements are matched distinctly

Two rules govern how a proof is checked against a tier, and the second was
found only by implementing the first.

**1. Authority is ordered.** A human `operator` satisfies a requirement for
`risk-engine`; a `ceremony` satisfies either. The reverse is never true —
automation must never satisfy a requirement for a human, because that is exactly
the substitution a compromised coordinator would like to make.

Without this, an operator acting directly on the hot tier is refused for
carrying too _much_ authority, which is nonsense — and the obvious workaround is
a proof falsely claiming `risk-engine`, which defeats the point of naming the
authority at all. This surfaced the first time an operator script asked the
signing service for a signature.

**2. Each requirement must be met by a DISTINCT authority.** Warm requires
`[risk-engine, operator]`, and that means **two independent approvals** — not
"an authority level of at least operator".

> Nearly missed. With rule 1 alone, a lone `operator` satisfies the operator
> requirement and, through the ordering, the risk-engine one as well — silently
> reducing warm from two approvals to one, which is the entire protection warm
> exists to provide. A test asserting that a lone operator is refused on warm is
> what caught it, and that test is now the one to keep.

### Thresholds and rebalancing

- Hot has a **ceiling** and a **floor**, both configuration.
- Exceeding the ceiling schedules a hot → warm movement of the excess.
- Falling below the floor raises a top-up request — warm → hot, which requires
  the operator proof, because it is a movement _out of warm_.

The asymmetry is deliberate. Moving money **into** colder storage is automatic
and safe to get wrong in the conservative direction. Moving money **out of**
colder storage is the privileged operation, and the direction an attacker wants.

Rebalancing is a sweep in mechanics (ADR-0017) and a tier movement in
accounting: `chain_assets:hot` to `chain_assets:warm`, no user liability change.

## What this does NOT protect against

Recording this plainly, because a tier table invites more confidence than it
earns:

- **Cold is not offline in this project.** A genuinely cold tier means key
  material that has never touched a networked machine, and a movement means a
  human in a room with a procedure. What is implemented here is _a signing
  policy that requires proofs this system cannot produce on its own_. That is
  the honest description, and it is meaningfully different from air-gapped
  custody. The runbook says so.
- **All tiers run the same participant software** (ADR-0015). A vulnerability in
  it is not tiered.
- **The operator role model is only as strong as operator authentication.** A
  warm tier requiring "an operator signature" is worth exactly what it costs to
  become an operator. This is why prompt_phase4.md rule 166 replaces Phase 3's
  configured list of user ids with a real role model, and why that work is part
  of this phase rather than after it.
- **Tiering bounds loss, it does not prevent it.** A hot-wallet compromise still
  loses the hot balance. The ceiling is the control that decides how much that
  is, and it is the only one that does.

## Alternatives considered

**Tiers distinguished by address only.** The cheapest option: four addresses,
one signing policy. Rejected — this is exactly rule 137's label-not-segregation
failure, and it is the status quo Phase 3 left behind.

**Tiers distinguished by threshold count alone** — hot 2-of-5, warm 3-of-5, cold
4-of-5. Considered, and partially adopted, but rejected as the _primary_
mechanism. Raising the threshold protects against participant compromise; it
does nothing against a compromised coordinator asking five honest participants
for a cold movement. The authorization requirement is the control that
addresses that, and the threshold is a secondary control on top.

**A separate key per tier with no threshold on the colder ones.** Rejected:
inverts the protection, giving the least protection to the largest balance.

**No warm tier — hot and cold only.** Genuinely simpler, and many custodians do
exactly this. Rejected because the floor/ceiling rebalancing then swings
directly against cold, which means routine operations touch the tier whose whole
value is being rarely touched. Warm exists to absorb that.

## Consequences

- `CustodyTier` stops being a decorative enum and becomes a required input to
  the signing path. Every signing request names a tier, and the participant
  validates the proof against that tier's policy.
- Four addresses to fund, monitor and reconcile. Reconciliation must cover every
  tier (prompt_phase4.md rule 141), or the residual is approximate in a new way.
- A hot-wallet ceiling breach is an operational alert, not a silent transfer.
- Warm and cold movements need an operator identity, an audit entry naming that
  operator, and a runbook. A key ceremony is a documented procedure with a
  status (rule 155), not an ad-hoc afternoon.
- The withdrawal path gains a tier-selection step: which tier funds this
  withdrawal. Ordinary withdrawals are served from hot, and one that cannot be
  is an operational event, not an error.
