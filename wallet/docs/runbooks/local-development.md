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

**Localnet suites fail with counts that grow by one on each run.** The database
was reset while the validator was not. Deposit addresses are derived
deterministically from `DEPOSIT_SEED` at a sequential index (ADR-0004), so
resetting the database restarts that index and re-issues addresses that already
carry on-chain history from earlier runs — their old airdrops are indexed as
genuine deposits, because that is exactly what they are.

Reset both together, or neither:

```bash
pnpm --filter @wallet/db reset
solana-test-validator --reset --quiet --ledger /tmp/test-ledger
```

The localnet suites assert on their own transaction signature rather than on a
per-user total, so they tolerate a dirty validator. Anything asserting a total
balance will not.

**The nonce pool is empty after running the integration suite.** The API test
helpers call `nonceAccount.deleteMany({})` so each suite provisions its own
against the fake chain. Real durable nonce accounts created by
`pnpm --filter @wallet/api provision-nonces` are deleted along with them — the
accounts still exist on chain, but the pool that leases them does not know about
them any more.

Re-provision before manual testing:

```bash
pnpm --filter @wallet/api provision-nonces
```

Without a pool every signing cycle logs `nonce.pool_exhausted` and no withdrawal
can be built.

**E2E tests fail with `locator.click` timeouts.** `playwright.config.ts` sets
`reuseExistingServer: !process.env.CI`, so a dev server you started by hand is
reused — and it will not have the suite's raised rate limits. Two dozen browser
journeys from one IP then exceed the per-minute ceiling, `/auth/session` gets
throttled, the app correctly decides the user is signed out, and unrelated
assertions fail on pages that are working fine.

The symptom is a `register()` that clicks successfully and then sits on
`/register`: the auth limiter returned 429 and the UI correctly did not
navigate. It is intermittent, because it depends on how many requests fell
inside the rolling minute — which makes it look like a test bug rather than a
configuration one.

Stop your own servers before running E2E. `pkill -f "tsx watch"` is **not
enough** — it kills the tsx child and leaves the `pnpm` parent, which keeps the
port bound and gets reused anyway:

```bash
pkill -f "filter @wallet/api dev"; pkill -f "filter @wallet/web dev"
lsof -ti tcp:4000 | xargs -r kill -9
lsof -ti tcp:3000 | xargs -r kill -9
pnpm test:e2e
```

To confirm which server a run is using:

```bash
ps eww $(lsof -ti tcp:4000 | head -1) | tr ' ' '\n' | grep RATE_LIMIT
```

A Playwright-started server reports `RATE_LIMIT_AUTH_PER_IP_PER_MINUTE=100000`.
Anything else is a reused server and the suite will be flaky.

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
