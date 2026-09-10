# Runbook: local development

## First run

```bash
cp .env.example .env

# Fill in the two generated values in .env:
openssl rand -base64 48   # -> SESSION_SECRET
openssl rand -base64 32   # -> TOTP_ENCRYPTION_KEY

pnpm install
pnpm infra:up                 # PostgreSQL on :5433, Redis on :6380
pnpm --filter @wallet/db generate
pnpm --filter @wallet/db migrate:deploy
pnpm dev
```

API on `http://localhost:4000`, web on `http://localhost:3000`.

Ports 5433/6380 rather than the defaults, so a Postgres or Redis already
running on this machine is left alone.

## Common problems

**"relation does not exist" as the app user.** The schema-scoped grants were
dropped — usually by a `migrate reset` against a database whose grants only ever
came from the container init script. Re-run migrations; the grants are a
migration (ADR-0003).

**Config refuses to start and names a variable.** That is the design (rules
59-61). The message names the variable and never prints its value.

**`WEBAUTHN_RP_ID` rejected at boot.** It must equal the `WEBAUTHN_ORIGIN` host
or be a registrable suffix of it. `localhost` with `http://localhost:3000` is
correct.

**Passkey prompt never appears.** WebAuthn requires a secure context: `https`,
or `localhost` exactly. `127.0.0.1` will not do.

## Resetting

```bash
pnpm --filter @wallet/db reset   # drops and re-migrates; all data lost
pnpm infra:nuke                  # also destroys the volumes
```

## Verifying the security properties by hand

```bash
# Append-only audit_log — both must be refused
docker exec -e PGPASSWORD=wallet_app wallet-postgres \
  psql -h localhost -U wallet_app -d wallet -c "UPDATE audit_log SET event='x';"
docker exec -e PGPASSWORD=wallet_app wallet-postgres \
  psql -h localhost -U wallet_app -d wallet -c "DELETE FROM audit_log;"

# No DDL for the app role
docker exec -e PGPASSWORD=wallet_app wallet-postgres \
  psql -h localhost -U wallet_app -d wallet -c "CREATE TABLE nope (id int);"

# The architectural boundaries actually bite
node scripts/verify-boundaries.mjs
```
