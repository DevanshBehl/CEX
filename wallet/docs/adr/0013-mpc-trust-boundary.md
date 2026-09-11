# ADR-0013: The MPC trust boundary

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 4a

## Context

`services/mpc` holds key material. Everything about how the API reaches it is a
security decision: the transport, the authentication, and — most importantly —
**what the API is permitted to ask for**.

master-prompt rules 21, 24 and 167 require the signing service to be isolated,
auditable, and treated as a high-security boundary. prompt*phase4.md rules 51–52
require a separate \_process*, not a library: a library shares the API's memory,
its crash, and its attack surface.

## Decision

### Transport and authentication

**HTTP over TLS, with every request signed by the caller.**

TLS is served by `rustls` (via `axum-server`) rather than OpenSSL: no system
dependency, and a memory-safe implementation for the one process holding key
material. Where TLS is terminated at a proxy instead, the service **refuses to
start on a non-loopback address without a certificate** — so "we meant to put a
proxy in front of it" is enforced by the process rather than left as an
intention.

| Layer           | Mechanism                      | Protects against                            |
| --------------- | ------------------------------ | ------------------------------------------- |
| transport       | TLS 1.3                        | eavesdropping, tampering in transit         |
| caller identity | Ed25519 request signature      | an unauthorised process reaching the signer |
| replay          | `requestId` + timestamp window | a captured request being resubmitted        |

The API holds a **client signing key**; the MPC service holds only the
corresponding **public** key. The service verifies every request before doing
anything else, and refuses — loudly and auditably — on failure.

Request signatures rather than mutual TLS: mTLS is the stronger primitive, but
its failure mode during rotation is an outage, and certificate plumbing is where
this kind of boundary usually rots. A signed request is verifiable from a
single public key, is easy to test, and leaves an artifact in the audit log that
mTLS does not. **Both** are used — TLS for the channel, signatures for the
caller — so this is not a choice between them.

### The API's vocabulary

This is the part that matters most. The API may ask for exactly three things:

```
POST /v1/sign        { requestId, keyRef, payload, authorization }  → signature
GET  /v1/public-key  { keyRef }                                      → public key
GET  /v1/health                                                      → liveness
```

There is deliberately **no** endpoint to export a key, list keys, import key
material, or change authorisation policy. The absence is the design: an
operation that does not exist cannot be called by a compromised API.

### What the service will not do

- It will not return key material, in any form, through any endpoint.
- It will not reconstruct a complete private key for convenience
  (master-prompt rule 99) — and in 4b it must be structurally unable to.
- It will not **decide policy**. It validates the `AuthorizationProof` it is
  given and refuses without one, but it does not evaluate risk rules
  (master-prompt rule 109). Authorising and signing stay separate systems.

### Idempotency is enforced service-side

The same `requestId` returns the same signature and starts no second signing
operation. Enforced **inside** the service, not in the client
(prompt_phase4.md rule 64): a retrying client, a duplicated queue message, or a
hostile caller must not be able to cause a second signing operation.

In 4a that is a correctness and audit property. In 4b it becomes a
key-recovery one, because a duplicate FROST round on one nonce is exactly the
failure that recovers a share.

## Alternatives considered

**Unix socket, same host.** Simpler, no TLS, and the kernel authenticates the
peer. Rejected because it forces the signer onto the API's host, which
contradicts 4b's requirement that participants be separate hosts — the boundary
would have to be rebuilt one phase later.

**gRPC with mTLS only.** master-prompt rule 35 names gRPC as a future option.
Rejected for 4a on the grounds that the request-signature scheme is easier to
test and audit, and produces a verifiable artifact for the audit log. Worth
revisiting when there are five participants and the coordination chatter grows.

**A message queue between API and signer.** Decouples availability nicely.
Rejected because a signing request is synchronous from the caller's point of
view, and a queue adds a place for a request to sit in an unknown state —
precisely the ambiguity ADR-0009 went to some length to remove elsewhere.

**No caller authentication, relying on network isolation.** Rejected outright.
Network isolation is a control that fails silently and invisibly, and "the
signer will only ever be reachable from the API" is a sentence that stops being
true without anyone noticing.

## Consequences

- The API holds a signing key whose compromise lets an attacker _ask_ for
  signatures. It does not let them extract key material, and in 4b it does not
  let them bypass participant-side authorization checks (ADR-0015).
- Rule 74 of prompt_phase4.md becomes achievable: `SIGNER_KIND=real` stops
  throwing once this boundary exists.
- Key rotation for the client signing key needs a procedure and a runbook.
  Until then it is a recorded gap.
- There are now **two** keys on the API side with different jobs: the client key
  proves who is asking, and the approval key proves the request was approved
  (ADR-0015). Compromising the first lets an attacker ask; the second is what
  stops asking from being enough. They must not be the same key, and must not
  be stored together.
- The service needs its own health endpoint, which `/health/ready` already has
  room for — the array shape was designed for this in Phase 1.
- Every request and outcome is recorded in the service's own audit log, in the
  shape `signing_requests` already uses. Never the payload's secrets, never the
  key (master-prompt rule 110).
