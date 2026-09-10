# Runbook: rotating SESSION_SECRET and revoking all sessions

**Applies to:** Phase 1 · **Audience:** whoever is on call

## What SESSION_SECRET actually does here

Less than its name suggests, and that is deliberate. Session tokens are 32 bytes
of randomness stored as a SHA-256 hash (ADR-0001) — they are **not** signed with
this secret. `SESSION_SECRET` is passed to `@fastify/cookie` for signed-cookie
support.

**Consequence: rotating `SESSION_SECRET` does not by itself invalidate any
session.** If you are rotating because you believe sessions are compromised, you
must revoke the sessions too. Step 3 is the one that matters.

## When to run this

- A secret has leaked, or is suspected to have leaked.
- Scheduled rotation.
- After anyone with production access leaves.

## Steps

### 1. Generate a new secret

```bash
openssl rand -base64 48
```

Never reuse a value, never commit one, never paste one into a ticket or a chat.

### 2. Deploy the new value

Update it in the secret manager (or `.env` locally) and restart the API. Config
is validated at boot, so a malformed value stops the process immediately with
the variable named and **no value printed** — safe to paste into an incident
channel.

### 3. Revoke sessions — the step that actually logs people out

Revoke everything:

```sql
UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;
```

Revoke one user:

```sql
UPDATE sessions SET revoked_at = now()
WHERE user_id = '<uuid>' AND revoked_at IS NULL;
```

Run these as `wallet_owner`. `wallet_app` can do it too — `sessions` is an
ordinary table — but an incident action belongs in an audited admin session.

Effect is immediate: the session guard resolves by token hash on every request
and treats a non-null `revoked_at` as no session at all.

### 4. Confirm

```sql
SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > now();
```

Then check that a browser that was signed in is bounced to `/login`.

### 5. Record it

`audit_log` is append-only and cannot be written retroactively by hand for a
manual action. Note the incident, the time, and the row counts wherever
incidents are tracked.

## What this does NOT do

- **Does not rotate `TOTP_ENCRYPTION_KEY`.** That one is load-bearing: it
  decrypts stored TOTP secrets. Changing it without re-encrypting makes every
  enrolled authenticator undecryptable and forces every user to re-enroll. There
  is no re-encryption tooling in Phase 1 — write it before you need it.
- **Does not revoke passkeys.** A revoked session means signing in again; the
  credential is untouched. To remove a credential, use the security page or set
  `credentials.revoked_at`.
- **Does not affect in-flight WebAuthn ceremonies.** Those live in Redis with a
  short TTL and expire on their own.
