# ADR-0001: Opaque server-side sessions, not JWTs

- **Status:** accepted
- **Date:** 2026-09-10
- **Phase:** 1

## Context

Every request to a protected endpoint has to establish who is calling. The two
standard shapes are a self-contained signed token (JWT) that the server
validates without a lookup, and an opaque random token that indexes a row in a
session store.

master-prompt rule 165 requires secure session handling, and prompt*phase1.md
rules 121-128 require sessions that can be listed, rotated, and revoked —
including revoking every \_other* session when a credential changes.

## Decision

Sessions are opaque 32-byte random tokens. The raw token exists only in an
httpOnly `SameSite=Strict` cookie; the database stores only its SHA-256 hash.
Every request resolves the session by hash.

## Alternatives considered

**JWT with a short expiry.** Genuinely tempting: no database round trip per
request, and it scales sideways without shared state. It loses on one point
that is not negotiable here — a JWT cannot be revoked before it expires.
"Revoke this session now" becomes "revoke it within fifteen minutes", and the
mitigation (a revocation blocklist checked on every request) reintroduces
exactly the per-request lookup the JWT was supposed to avoid, with more moving
parts. For a custody system where session revocation is a user-facing security
control, that is the wrong trade.

**JWT plus a refresh token.** Same problem one level up, and it doubles the
number of credentials in flight.

## Consequences

- Every authenticated request does one indexed lookup by token hash. At Phase 1
  volumes this is irrelevant; if it ever matters, the fix is a short-TTL cache
  keyed by hash, with revocation publishing an invalidation.
- `lastSeenAt` is written on every request to drive the idle timeout. If write
  amplification becomes a problem, skip the update when `lastSeenAt` is younger
  than some fraction of the idle TTL.
- A database dump does not yield usable sessions, because only hashes are
  stored.
- Horizontal scaling requires the shared PostgreSQL that this system already
  requires for the ledger. No new dependency.
