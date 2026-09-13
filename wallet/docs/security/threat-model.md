# Threat model

- **Status:** current as of Phase 5 (ADR-0023, distributed key generation)
- **Scope:** the custodial Solana wallet in this repository

prompt_phase4.md rules 157–158: this is a deliverable, not an exercise. It is
what makes "not production-safe" a specific statement rather than a disclaimer.
If you only read one section, read [What this does not protect
against](#what-this-does-not-protect-against).

---

## 1. What is being protected

In descending order of how bad it is to lose:

| Asset                                 | Where it lives                          | Loss means                                 |
| ------------------------------------- | --------------------------------------- | ------------------------------------------ |
| **Treasury signing key**              | `services/mpc`, encrypted under a KEK   | every user balance is gone                 |
| **DKG peer roster (`MPC_DKG_PEERS`)** | each participant's configuration        | whoever can rewrite it can read new shares |
| **Deposit master seed**               | `DEPOSIT_SEED`, API process memory      | every deposit key is regenerable           |
| **Key-encryption key (`MPC_KEK`)**    | MPC service environment                 | the treasury key at rest is readable       |
| **Approval authority key**            | API process, `MPC_APPROVAL_PRIVATE_KEY` | signatures can be authorised at will       |
| **Ledger integrity**                  | PostgreSQL, append-only                 | the platform cannot say what it owes       |
| **Session secret**                    | API process                             | any user's session can be forged           |
| **User funds in flight**              | the withdrawal state machine            | individual losses, bounded per withdrawal  |

The ledger is on that list deliberately. A custodian that cannot say what it
owes has failed even with every key intact.

## 2. Who the adversaries are

| Adversary                | Capability assumed                                              |
| ------------------------ | --------------------------------------------------------------- |
| **Remote attacker**      | Can reach the public API. No credentials.                       |
| **Credential thief**     | Has a user's password-equivalent, but not their authenticator.  |
| **Compromised API host** | Runs code in the API process. Reads its memory and environment. |
| **Compromised database** | Reads and writes every application table.                       |
| **Malicious operator**   | Holds valid operator credentials.                               |
| **Malicious depositor**  | Can send anything to any address we publish.                    |

## 3. What is defended, and by what

### Remote attacker

- **Authentication is WebAuthn** (ADR-0002). There is no password to phish or
  stuff, and a credential is bound to an origin.
- **Sessions are opaque and server-side** (ADR-0001), so a stolen cookie is
  revocable and carries no claims of its own.
- **CSRF** is checked by `Origin` with `Sec-Fetch-Site` as corroboration, and
  `Origin` wins when they disagree.
- **Rate limits** on authentication and withdrawal endpoints.
- **Risk decisions are never client-supplied** (master-prompt rule 154), and
  denials are coarse to the client so the endpoint is not a threshold oracle
  (ADR-0010).

### Credential thief

- **Step-up authentication** for withdrawals, with a freshness window
  (ADR-0011). A session alone cannot move money.
- **Clone detection** on the authenticator sign counter, tolerant of synced
  passkeys that legitimately report zero.
- **Destination controls**: a new destination triggers review.

### Compromised API host

This is the interesting one, and where most of Phase 4's design effort went.

- **It cannot sign.** Key material is in a separate process behind an
  authenticated channel (ADR-0013). The API holds a client key, not a signing
  key.
- **It cannot fabricate an authorisation** — if an approval key is configured.
  The signing service verifies the proof against a key it holds independently,
  bound to the exact payload hash (ADR-0015).
- **It cannot replay an approval onto a different transaction**, because the
  proof commits to the payload hash.
- **It cannot escalate a custody tier.** Warm and cold require authorities the
  API cannot produce, checked inside the signing service (ADR-0018).
- **It cannot redirect a sweep.** The deposit-key destination is configuration
  of the signing service, not a request field (ADR-0005, ADR-0017).
- **It cannot rewrite history.** `audit_log`, `ledger_entries`,
  `ledger_transactions`, `withdrawal_transitions` and `risk_decisions` are
  append-only by REVOKE plus trigger, enforced against the role the API uses.

What it **can** do: censor (refuse to run rounds — a liveness failure), and
choose which legitimate-looking requests to submit within the limits the risk
engine and tier policy allow.

### Compromised coordinator during key generation

Keys are generated by distributed key generation (ADR-0023). No trusted dealer
exists, and no code path generates more than one share of a group.

- **It never holds a key.** It relays round-1 commitments and proofs (public),
  round-2 envelopes (ciphertext), and verification shares (public). A test runs
  a real ceremony, reconstructs the secret out of band, and searches every byte
  the coordinator persisted for it.
- **It cannot read a share in transit.** Each share is sealed to its recipient's
  X25519 key. Peer keys are pinned in each participant's configuration and are
  never learned from the coordinator.
- **It cannot inject a share** under another participant's name. The envelope
  key includes a static-static DH that only the two participants can compute.
- **It cannot equivocate on commitments** without detection. Every envelope is
  bound to a hash of its sender's full round-1 view, so differing views fail to
  open and the ceremony aborts.
- **It cannot get a key recorded that the participants did not derive.** It
  checks, and every participant checks, that all five reached the same group
  package. Shares are installed only after that agreement, in a separate commit.

What it **can** do: abort ceremonies (liveness), and choose when to run them.
**A malicious participant** can also make a ceremony abort, and the log names
it. It cannot bias the key toward a value it knows or learn anything about the
secret.

### Compromised database

- **No signing material is in it** (master-prompt rule 95). The most sensitive
  values it holds are hashed session tokens and encrypted TOTP secrets.
- **Append-only tables resist tampering** by the application role, though not
  by a superuser.
- **Reconciliation compares against the chain**, so a silently edited ledger
  shows up as drift that does not resolve.

### Malicious depositor

- **Mint allowlist** (ADR-0016). An unrecognised mint is recorded and never
  credited, so it cannot become a liability.
- **Deposits are idempotent** on `(chain, tx_signature, instruction_index)`.
- **Metric labels are drawn from closed sets**, so dust from novel mints cannot
  create unbounded time series.

---

## What this does not protect against

The honest part. Each of these is a real gap, not a theoretical one.

### Unaudited by anyone outside this project

No independent security review has been performed. Custody systems fail at
composition and operation far more often than at primitives, and composition is
exactly what an internal reviewer is worst placed to judge. **Master-prompt
rule 8 applies in full.**

### The deposit master seed is hot

`DEPOSIT_SEED` lives in the API process's environment and can regenerate every
deposit key. It is the single most valuable secret outside the MPC service, and
it is held by the component most exposed to the internet. ADR-0005 accepted this
on the grounds that a deposit key's authority is narrow — it can only sweep to a
fixed destination — but the seed's blast radius is still every user's deposit
address between sweeps. Moving it behind the MPC boundary is named in
prompt_phase4.md rule 162 and is **not done**.

### Threshold signing is implemented, but has never been run across real hosts

3-of-5 FROST-Ed25519 exists and is tested: any three participants sign, any two
fail cleanly, a single share produces nothing valid, and nonce reuse is refused
by the store rather than by care. What has **not** happened is a deployment
across five independent hosts with five sets of credentials — the tests run
five participants in one process, each with its own store and its own KEK, which
is as close as a test can get and is not the same thing.

`MPC_ROLE=single-key` also remains the default. A deployment that has not
changed it has one key in one process, and one host compromise yields the
treasury key. The service says so at boot.

### Keys created before ADR-0023 were made by a trusted dealer

Until DKG landed, the house key and every per-user key were generated by the
coordinator and handed out as shares. Those shares still sign, but whoever
controlled the coordinator when they were made could have kept a copy of the
whole key. Deployments with pre-ADR-0023 keys, including the devnet keys used to
verify ADR-0020, should treat them as dealer-exposed and move funds to
DKG-generated keys.

### The DKG roster is only as trustworthy as its distribution

Pinning `MPC_DKG_PEERS` is what stops the coordinator reading shares. If
one party can write that value to every participant, that party can put itself
in the middle of future ceremonies. The runbook requires distributing it
through a channel the coordinator's operators do not control. Nothing in the
software can enforce that.

### All participants would share a deploy pipeline

Even once 3-of-5 exists, all five would be deployed by the same CI from the same
repository. Whoever controls that controls all five, and the threshold protects
nothing against them. Fixing this is organisational, not technical.

### Cold is not cold

ADR-0018's cold tier is a signing policy requiring proofs this system cannot
produce on its own. It is not air-gapped key material in a safe. That is a
meaningful protection against a compromised coordinator and is **not** the
protection the word "cold" implies in custody.

### Secrets can come from a file, but not yet from a managed store

Secrets are resolved from references — `env:OTHER_VAR` or `file:/run/secrets/x`
— and production **refuses** the deposit seed or the KEK as a literal. What does
not exist is an integration with a managed store (AWS Secrets Manager, Vault):
adding one is a new `SecretSource`, not a change to every call site, but it is
not written.

So a deployment using `file:` mounts is meaningfully better than `.env` and is
still only as good as the filesystem it mounts from. There is also still no
rotation path for most secrets.

### `TOTP_ENCRYPTION_KEY` cannot be rotated

There is no re-encryption path for stored TOTP secrets. Rotating the key
invalidates every enrolled authenticator. This is **accepted and recorded**
rather than fixed (rule 167).

### The operator model has roles, but no four-eyes

Roles are granted in the database (`viewer`, `approver`, `custodian`), revocable
without a restart, and the grant history is append-mostly so "who could approve
withdrawals in March" stays answerable. Granting is a CLI on the host rather
than an endpoint, so a compromised operator session cannot mint more operators.

What is still missing: **separation of duties**. One `approver` can approve a
withdrawal alone; nothing requires two. A warm-tier movement requires "an
operator signature", which is worth exactly what it costs to become an operator.

### The dead-letter queue is in memory

A restart loses the queue. The underlying withdrawal rows survive in their
terminal state, which is where recovery actually starts, but the operator's
view of what failed does not.

### Availability is not defended

No DDoS protection, no capacity planning, no circuit breakers beyond retry
budgets. A determined attacker can make the platform unavailable. Funds stay
safe; the service does not stay up.

### The web frontend is trusted more than it should be

There is no Subresource Integrity, no strict CSP nonce discipline, and a
compromised frontend can show a user a destination address different from the
one submitted. Server-side validation limits the damage to destinations the risk
engine would accept, which is not nothing and not enough.

---

## Assumptions that, if false, invalidate the above

1. The Solana RPC endpoint is honest about confirmation status.
2. `finalized` commitment means what the network says it means.
3. Ed25519 as implemented by `ed25519-dalek` is sound.
4. PostgreSQL's Serializable isolation is correctly implemented.
5. The host's entropy source is not compromised — on **each** participant, since
   each samples its own DKG polynomial.
6. X25519, HKDF-SHA256 and ChaCha20-Poly1305 as implemented by the RustSec
   crates, and FROST DKG as implemented by `frost-core`, are sound.
7. Whoever holds the approval key is not the adversary.

## Review triggers

Re-read this document when: participants move to independent hosts, the DKG
roster distribution changes, threshold signing lands, a second chain is added, an
operator role model replaces the id list, the deposit seed moves, or any
component gains a network-reachable surface it did not have.
