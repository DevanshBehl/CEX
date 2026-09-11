# ADR-0014: Key material at rest

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 4a

## Context

`services/mpc` holds a signing key in 4a and a FROST share in 4b. master-prompt
rule 95 requires signing material to live outside the ordinary application
database; rule 99 forbids reconstructing a complete private key for
convenience; rule 100 forbids it ever reaching the frontend.

prompt_phase4.md rule 56 states the property that has to be true **by
construction**: a dump of the application database contains no key material.

## Decision

### Storage

Key material lives in the MPC service's **own datastore**, encrypted at rest
with **AES-256-GCM**, under a key that is never stored beside the ciphertext.

```
  application database          MPC datastore
  ┌──────────────────┐          ┌────────────────────────────┐
  │ signing_requests │          │ keys                       │
  │  - requestId     │          │  - keyRef                  │
  │  - keyRef        │  ←────   │  - public_key              │
  │  - outcome       │  refs    │  - encrypted_secret (GCM)  │
  │  - authorization │  only    │  - created_at              │
  └──────────────────┘          └────────────────────────────┘
        no secrets                  never leaves this process
```

`keyRef` is an **opaque handle**. The application never learns what it points
at, which is why `KeyRef` has carried exactly one field since Phase 2.

### The encryption key

The key-encryption key (KEK) comes from a **secret manager** in any deployed
environment, and from an environment variable only in local development — the
same rule `.env` has always followed, and the same one master-prompt rule 157
states.

The KEK is never written to the MPC datastore. A database compromise therefore
yields ciphertext and nothing else.

### AES-256-GCM, not AES-CBC or a raw XOR

GCM is authenticated: a tampered ciphertext fails loudly rather than decrypting
to a different key. Reusing the encryptor already built in `packages/auth` for
TOTP secrets would have been convenient and is wrong — that key belongs to the
API, and the whole point of this boundary is that the API cannot decrypt signing
material.

### Generation

The key is generated **inside the service**, from the operating system's CSPRNG,
and the secret half never crosses the process boundary. There is no import
endpoint (ADR-0013) and no export endpoint.

### Recovery

**4a has no recovery path, deliberately.** A lost key means a lost treasury.

This is stated rather than solved because the correct solution is 4b: a 3-of-5
threshold where any two participants can be lost and the key survives, plus
share refresh to replace them (ADR-0015). Building a backup-and-restore
procedure for a single key would be work thrown away one sub-phase later, and
would create exactly the artifact this ADR exists to avoid — a copy of the key,
somewhere else.

Until 4b lands, **4a is for development and testing only**, and the README says
so.

## Alternatives considered

**A cloud KMS or HSM holding the key directly.** Genuinely stronger than
encrypted-at-rest-with-a-KEK, and what a real custodian would use for a single
key. Rejected as the _primary_ mechanism because master-prompt rules 5 and 108
call for threshold custody rather than single-key storage, and because a KMS
that signs on request is a single point of both compromise and availability —
which is the thing 4b exists to remove. It remains the right place for the KEK
itself.

**Deriving the key from a seed on each start, storing nothing.** Fewer secrets
at rest. Rejected for the same reason ADR-0005 rejected it for deposit keys: it
makes the seed hot, so it must be available continuously, which concentrates the
entire risk into one value rather than distributing it.

**Storing the key in the application database, encrypted.** Rejected outright.
It violates master-prompt rule 95, and it makes the property in rule 56 — that
an application database dump contains no key material — untrue by construction.

## Consequences

- The MPC service needs its own database, its own migrations, and its own
  least-privilege role (prompt_phase4.md rule 59). Its role must not reach
  application tables.
- Local development needs a KEK in `.env`, which is the one place a raw key
  material secret is acceptable and is gitignored like every other.
- Rotating the KEK requires re-encrypting the stored secrets. Build that path
  when 4b's share refresh is built, since the mechanics are the same.
- **`TOTP_ENCRYPTION_KEY` still has no re-encryption path** — a limitation
  recorded since Phase 1 and still open. Phase 4 rule 146 asks for it to be
  built or accepted; doing both keys at once is the cheap moment.
- A key ceremony procedure is a 4b deliverable, not a 4a one. There is nothing
  to ceremonially generate until there are shares.
