# ADR-0015: 3-of-5 FROST-Ed25519, across independent failure domains

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 4b

## Context

Phase 4b replaces the single signing key with t-of-n threshold signing. Two
things have to be decided, and the second matters more than the first:

1. The values of `t` and `n`.
2. **What a participant actually is** — a process, a host, an operator, or an
   organisation.

prompt_phase4.md rule 45 puts it directly: `2-of-3` across three processes on
one machine provides almost nothing; across three operators it provides a great
deal. The threshold is arithmetic. The independence is the security.

## Decision

**3-of-5 FROST-Ed25519**, implemented with the Zcash Foundation's
`frost-ed25519` crate (RFC 9591), with each participant on its own host, its own
datastore, and its own credentials.

## Why 3-of-5

| t-of-n     | Tolerates      | Needed to steal | Assessment                                |
| ---------- | -------------- | --------------- | ----------------------------------------- |
| 4-of-4     | 0 failures     | all 4           | any single outage blocks every withdrawal |
| 2-of-4     | 2 failures     | 2 colluders     | half the set is the threshold — too weak  |
| 3-of-4     | 1 failure      | 3 colluders     | workable, but one loss leaves no slack    |
| **3-of-5** | **2 failures** | **3 colluders** | **chosen**                                |
| 3-of-7     | 4 failures     | 3 colluders     | more availability, more operational load  |

3-of-5 was chosen over 3-of-4 because the collusion resistance is identical and
the availability is meaningfully better: two participants can be down —
one failed, one being patched — and withdrawals still work. With 3-of-4, losing
one participant means the next loss is an outage, which turns routine
maintenance into an event.

It was chosen over 3-of-7 because five independent failure domains is already a
real operational burden for this project, and the marginal availability does not
pay for the marginal ceremony cost.

## What a participant is

**A participant is a separate host with its own datastore and its own
credentials.** Five processes on one machine, five schemas in one PostgreSQL
instance, or five containers from one deploy pipeline would be five copies of
the same blast radius, and the threshold would be decoration.

| Separation             | Status            | Protects against                                   |
| ---------------------- | ----------------- | -------------------------------------------------- |
| separate process       | required          | a crash or memory disclosure in one participant    |
| separate datastore     | required          | a database compromise yielding more than one share |
| separate host          | required          | host compromise, and most lateral movement         |
| separate cloud account | recommended       | a compromised control plane                        |
| separate operator      | not in this phase | an insider, and a compromised deploy pipeline      |

### What this does NOT protect against

Stating it plainly, because the table above is where the honesty has to live:

- **A compromised deploy pipeline.** All five participants are deployed by the
  same CI in this project. Whoever controls that controls all five. Separate
  operators would fix it; that is an organisational change, not a code change.
- **A vulnerability in the participant software itself.** All five run the same
  binary. A bug that yields a share on one yields it on three.
- **A compromised coordinator, for availability.** See below.

Recording these is the point. A threshold scheme whose limits are not written
down invites the belief that it has none.

## The coordinator

FROST requires a coordinator to collect commitments, distribute the signing
package, and aggregate the shares. **The API is the coordinator.**

The coordinator **cannot forge a signature**. It never holds a share and
aggregation is not a privileged operation — an incorrect aggregation simply
produces an invalid signature.

It can do two things:

- **Censor.** A compromised coordinator can refuse to run rounds, which is a
  liveness failure, not a safety one. Funds stay locked and recoverable.
- **Choose what is proposed for signing.** Which is why the next section exists.

The coordinator is therefore a **liveness dependency, not a security one**, and
that is how it is documented and monitored.

## Participants validate the authorization

This is the decision that determines whether the threshold is worth building.

If each participant blindly signs whatever bytes the coordinator hands it, then
3-of-5 protects against **key theft** and nothing else. A compromised API could
simply ask for a signature over a transaction paying an attacker, and five
honest participants would produce it.

So **each participant independently verifies the `AuthorizationProof`** before
contributing a signature share.

**Implemented in 4a** (`services/mpc/src/signer.rs`), ahead of 4b, because the
single-key service has exactly the same exposure: without it, a compromised API
could fabricate a proof and have funds signed away without ever touching the
key. `MPC_APPROVAL_PUBLIC_KEY` configures it; absent, the service warns on every
request that it will sign anything well-formed, which is development-only.

The checks:

1. The proof is signed by the approval authority, verified against a key the
   participant holds independently of the coordinator.
2. The proof binds to **this exact payload hash** — so a proof for one
   withdrawal cannot be replayed onto another.
3. The proof has not already been used for a different `requestId`.

A participant does **not** re-run the risk rules. That would violate
master-prompt rule 109, which keeps authorising and signing separate, and it
would put policy in five places. It checks the attestation, not the policy.

This is also where custody tiers acquire meaning (prompt_phase4.md rules
115–116): a cold-tier movement requires a proof carrying a human operator's
signature, not just the risk engine's. Tiers that all accept the same proof are
labels, not segregation.

## Nonce discipline

In FROST, **reusing a nonce across signing rounds recovers the participant's
secret share.** Not weakens — recovers.

Therefore:

- Each participant persists its nonce state **before** publishing a commitment,
  and refuses to produce a second share for a nonce it has already used.
- Enforcement lives in the participant, not in the coordinator. A retrying
  client, a duplicated queue message, or a hostile coordinator must not be able
  to cause a second round on the same nonce.
- This is why `SignRequest.requestId` has been an idempotency key since Phase 2
  rather than a convenience (prompt_phase4.md rules 88–89).

## Share refresh

Build resharing **before it is needed**. `frost-core` supports repairing a
participant's share from a threshold of the others.

Losing a participant with no recovery path means running a full key ceremony
under pressure, with a live treasury and an audience — which is exactly the
circumstance in which ceremonies go wrong. A tested refresh path turns a lost
participant into a scheduled task.

Refresh also rotates shares without changing the group public key, so the
treasury address is stable across it.

## Alternatives considered

**A single key in an HSM.** Simpler, genuinely strong, and what many custodians
actually use. Rejected because master-prompt rules 5 and 108 call for threshold
custody rather than single-key storage, and because the project exists to teach
that architecture. An HSM is also a single point of both compromise and
availability.

**Multisig on-chain rather than threshold signing off-chain.** Solana supports
multiple signers natively. Rejected because it is visible on-chain (revealing
the custody topology), costs more in fees and transaction size, and would change
the transaction shape — whereas FROST produces an ordinary Ed25519 signature, so
`packages/solana` and the withdrawal lifecycle are untouched.

**A threshold scheme other than FROST.** Rejected on maturity: FROST is
specified in RFC 9591, has an established Rust implementation, and produces a
standard signature. Master-prompt rule 106 forbids inventing cryptography, and
choosing a less-reviewed scheme is a soft version of the same mistake.

## Consequences

- Five hosts, five datastores, five sets of credentials to provision, monitor,
  patch and back up. This is the real cost and it is ongoing.
- Withdrawal latency gains two network round trips. Irrelevant against the ~13
  seconds finality already requires (ADR-0006), and the durable nonce (ADR-0009)
  means the added latency is not a correctness concern.
- The availability SLO is "any two participants may be unavailable". Monitoring
  must alert when only three remain, because at that point the next failure is
  an outage.
- A key ceremony is required to start, and a documented refresh procedure to
  continue. Both are runbook deliverables (prompt_phase4.md rule 214).
- **This is unaudited.** Composition and operation are where custody systems
  fail, not primitives. Master-prompt rule 8 applies in full.
