# MPC Custodial Wallet

An educational custodial Solana wallet platform, built in four phases.
**Phase 1 (identity) and Phase 2 (custody and money-in) are complete.**

> Not audited. Not production custody. Never point this at real funds.
> — master-prompt rules 7–8

| Document                                 | What it is                                                  |
| ---------------------------------------- | ----------------------------------------------------------- |
| [`master-prompt.md`](./master-prompt.md) | The 200-rule specification for the whole system             |
| [`report.md`](./report.md)               | The four-phase build plan and system design                 |
| [`prompt_phase1.md`](./prompt_phase1.md) | The 210-rule implementation contract for Phase 1 (complete) |
| [`prompt_phase2.md`](./prompt_phase2.md) | The 228-rule implementation contract for Phase 2 (next)     |
| [`docs/adr/`](./docs/adr)                | Decisions and the trade-offs behind them                    |
| [`docs/runbooks/`](./docs/runbooks)      | Local setup, secret rotation                                |

## What works today

A person can create an account with a passkey, sign in with no password and no
seed phrase, manage their passkeys and sessions, and turn on two-factor
authentication. They can then get a Solana deposit address, send SOL to it, and
watch it appear in their balance — recorded in a double-entry ledger that the
database itself refuses to let anyone falsify.

## What it deliberately does NOT do

**Money can arrive and be accounted for. It cannot leave.**

There is no withdrawal path, no transaction signing, and no risk engine. That is
the shape of Phase 2 on purpose: deposits need no signing, so the ledger gets
proven correct before any key material exists. Building withdrawals first would
mean debugging accounting bugs and signing bugs at the same time, with no way to
tell which layer is wrong.

Also absent, by design: SPL tokens (ADR-0008), sweeps from deposit addresses
into a hot wallet, and hot/warm/cold segregation. Those are Phase 4, and each
depends on signing.

## Quick start

```bash
cp .env.example .env
openssl rand -base64 48   # -> SESSION_SECRET in .env
openssl rand -base64 32   # -> TOTP_ENCRYPTION_KEY in .env
openssl rand -base64 64   # -> DEPOSIT_SEED in .env

pnpm install
pnpm infra:up                              # PostgreSQL :5433, Redis :6380
pnpm --filter @wallet/db generate
pnpm --filter @wallet/db migrate:deploy

# A local chain, for deposits to actually arrive.
solana-test-validator --reset

pnpm dev
```

- Web — http://localhost:3000
- API — http://localhost:4000
- Health — http://localhost:4000/health/ready

**Ports 5433 and 6380, not the defaults.** 5432 and 6379 are commonly already
taken by a system Postgres or Redis, or by another project's containers, and a
port collision surfaces as a confusing "port is already allocated" from Docker
rather than anything about this project. If you have another container bound to
5433, stop it (`docker stop <name>`) or change the mapping in
`infra/docker-compose.yml` and the two URLs in `.env`.

Full detail in [`docs/runbooks/local-development.md`](./docs/runbooks/local-development.md).

## Layout

```
apps/
  api/        Fastify — routes → controllers → services → repositories
              plus the indexer worker and the reconcile script
  web/        Next.js — pages, feature folders, one typed API client
packages/
  types/      Zod schemas — the single source of truth for every contract
  config/     the ONLY place process.env is read
  logger/     structured JSON, correlation IDs, allowlist redaction
  errors/     typed hierarchy with stable, client-facing codes
  db/         Prisma schema, migrations, repositories, transaction helper
  auth/       WebAuthn, sessions, TOTP, step-up, CSRF
  ledger/     double-entry accounting — pure, no chain, no database
  blockchain/ chain-agnostic interfaces — no implementation, no chain names
  solana/     the only package allowed to import a Solana SDK
infra/        docker-compose: PostgreSQL + Redis
scripts/      verify-boundaries.mjs — proves the lint rules actually bite
```

There is no `packages/risk` or `services/mpc` yet. Empty packages rot and
misrepresent the architecture, so they arrive with the phase that needs them —
and `verify-boundaries.mjs` fails the build if anything imports one early.

## The rules that shape this code

Six decisions do most of the work. Each is enforced by something automated, not
by anyone remembering.

**1. `process.env` is read in exactly one file.** `packages/config/src/env.ts`.
Everything else imports validated, frozen config. A missing variable stops the
process at boot with the variable named and **no value printed**.
_Enforced by:_ ESLint, `verify-boundaries.mjs`.

**2. Logs use an allowlist, never a denylist.** A field not named in
`packages/logger/src/allowlist.ts` is dropped, and so is any non-primitive
value, so nothing tunnels through an approved key. A denylist fails **open** the
first time someone adds a sensitive field; by Phase 4 the payloads here include
signing requests.
_Enforced by:_ `leak.test.ts`, which throws every secret this system will ever
hold at the logger and asserts none reaches the output.

**3. `fetch` is called in exactly one place.** `apps/web/lib/api/`. Every
response is _parsed_ against the same Zod schema the server validated against —
never cast.
_Enforced by:_ ESLint, `verify-boundaries.mjs`.

**4. `audit_log` is append-only, enforced by PostgreSQL.** The application role
is not granted `UPDATE` or `DELETE`, and a trigger stops the schema owner too.
Phase 2 reuses this verbatim for `ledger_entries` — proving it now, where a
mistake costs an audit trail rather than someone's balance, is the point.
_Enforced by:_ database grants, triggers, integration tests. See ADR-0003.

**5. Sessions are opaque and revocable, not JWTs.** 32 random bytes in an
httpOnly `SameSite=Strict` cookie; only a SHA-256 hash is stored. A JWT cannot
be revoked before it expires, and revocation is a user-facing security control
here. See ADR-0001.

**6. Step-up authentication exists already.** `requireStepUp` gates credential
and 2FA changes in Phase 1. Phase 3 puts the identical primitive in front of
withdrawal submission — built and proven now, against operations where a bug
costs an inconvenience rather than money.

## The accounting model

The ledger is double-entry. A balance is never stored; it is **always** a
projection over `ledger_entries`, and there is a test asserting no balance
column exists anywhere in the schema.

| Account type     | Class     | Holds                                           |
| ---------------- | --------- | ----------------------------------------------- |
| `user_available` | liability | what a user may spend                           |
| `user_locked`    | liability | reserved against a pending withdrawal (Phase 3) |
| `chain_assets`   | asset     | what the platform controls on-chain             |
| `house_rent`     | equity    | SOL immobilised in rent-exempt minimums         |
| `house_fees`     | equity    | network fees paid or collected                  |
| `external`       | contra    | the world outside this system                   |

**Direction convention**, stated once so it is never guessed at:

```
debit  → increases an asset,    decreases a liability
credit → increases a liability, decreases an asset
```

A deposit of 1 SOL is therefore `debit chain_assets 1` + `credit
user_available 1`, and the two sum to zero. That is what "balanced" means, and
PostgreSQL enforces it with a deferred constraint trigger at commit.

**`user_locked` is a separate account, not a column.** This is the most
consequential structural decision in the package. A lock becomes a balanced
transfer between two accounts — visible in the entry history, reversible by the
same mechanism that created it, impossible to get half-done. A `locked_amount`
column is a mutation: invisible after the fact, and reversible only by
remembering to subtract the right number. Phase 2 creates the account and never
uses it; Phase 3's withdrawal state machine is what gives it a purpose.

**Rent is not the user's.** The first deposit to an address must leave the
network's rent-exempt minimum behind for the account to exist. Crediting that to
the user would create an obligation the platform cannot meet, so it goes to
`house_rent` and the Activity page shows the split explicitly.

## Testing

301 tests: 189 unit, 98 integration, 14 end-to-end.

```bash
pnpm test              # unit — no infrastructure needed
pnpm test:integration  # against real PostgreSQL, never a mock or SQLite
pnpm test:e2e          # Playwright, real WebAuthn via a virtual authenticator
node scripts/verify-boundaries.mjs

# Optional: the localnet suites, which need a real chain
solana-test-validator --reset
pnpm test:integration
```

Integration tests run against real PostgreSQL because what they assert — role
grants, an append-only trigger, a deferred balance constraint, transaction
rollback, unique constraints — are properties of Postgres, not of the repository
code. A mock would pass while proving nothing.

Most deposit tests drive a **fake chain**, because restart safety and
idempotency are properties of _ordering_ — what commits before what — and
proving them needs the ability to stop at an exact point, replay a page, and
reorder events. A real validator cannot be asked to do that. Separate localnet
suites then prove the real adapter is wired to the real pipeline; they skip
cleanly when no validator is running, because a skip is honest and a mocked
"localnet" test is not.

## What the tests actually caught

### Phase 2

**1. Prisma reported success for a transaction PostgreSQL rolled back.** The
ledger's balance check is a DEFERRED constraint, so it fires at COMMIT — and
Prisma's `$transaction` resolves with the callback's return value even when
that commit is rejected. An unbalanced ledger write was refused by the database,
wrote nothing, and the application was told it succeeded. For a ledger that is
the worst failure mode available: the books say the money did not move, the code
says it did, and nothing errors. `withTransaction` now issues `SET CONSTRAINTS
ALL IMMEDIATE` before returning, forcing the check inside the transaction where
the error propagates. There is a regression test.

**2. The serialization-conflict retry never fired.** `withTransaction` defaults
to Serializable because the ledger needs it, and under Serializable write
conflicts are _normal_ — retrying is what makes the isolation level usable.
Prisma reports a conflict as `P2034` and does not surface the underlying `40001`
SQLSTATE, which is all the predicate checked. Two concurrent deposits to one
account produced a 500 instead of one of them taking a moment longer.

**3. Two ESLint boundary rules stopped enforcing when Phase 2 packages
arrived.** The Phase 1 config banned `@wallet/ledger` and `@solana/*` outright.
Once those legitimately existed, the bans had to become scoped — and rewriting
them re-introduced the flat-config merge trap from Phase 1. `verify-boundaries`
caught it again, which is the second time that script has paid for itself.

**4. The RPC loses precision above 2^53 before any of my code runs.**
`@solana/web3.js` parses balances with `JSON.parse`, so a lamport value above
9,007,199 SOL is already rounded on arrival. It does not affect Phase 2 — one
user's deposit address will not hold that much — but it would affect a hot
wallet, and the fix is a bigint-aware transport. Documented and covered by a
test that asserts the behaviour rather than hiding it.

### Phase 1

Every one of these was found by the suite, not by reading the code. They are
listed because they are the argument for the tests existing, and because
several are mistakes worth not repeating.

1. **Auth guards ran after schema validation.** Registered as Fastify
   `preHandler`, which runs _after_ body validation, an unauthenticated request
   to a protected route with a body schema was answered `400 VALIDATION_FAILED`
   instead of `401` — describing the shape of a protected endpoint to a caller
   the server had not yet authenticated. Now `preValidation`: authenticate
   first, then validate.

2. **`revokeAllOthers(userId, '')`.** An empty string where a session id
   belongs. Postgres tried to parse `''` as a UUID and returned 500 for the
   whole request. The caller's own session id is now threaded through
   `RequestMeta`.

3. **Two ESLint boundary rules were silently not enforcing.** Flat config
   _replaces_ a rule's options when a later block configures the same rule — it
   does not merge them — so a later `no-restricted-imports` block wiped the
   earlier patterns. Nothing failed; the rules simply stopped applying. This is
   exactly what `scripts/verify-boundaries.mjs` exists to detect.

4. **CSRF rejected every legitimate request.** The API is a separate origin, so
   browsers send `Sec-Fetch-Site: same-site`, not `same-origin` — "site"
   ignores the port. Requiring `same-origin` rejected the entire application.
   `Origin` is now the authoritative check; see the comment in
   `packages/auth/src/csrf.ts`.

5. **`NODE_ENV=development` leaked into the production build.** Next.js failed
   while prerendering `/404` with `<Html> should not be imported outside of
pages/_document` — naming a file this project does not have. Diagnosis was
   slowed by Turbo replaying a cached success over a genuinely broken build; if
   a build result looks impossible, clear `.turbo` before believing it.

## Known limitations (Phase 2)

- **`user_locked` exists and is never used.** Phase 2 creates the account and
  proves the structure supports locking; Phase 3's withdrawal state machine is
  what gives it a purpose.
- **Funds stay where they land.** There are no sweeps into a hot wallet, so
  every user's balance sits at their own deposit address. Sweeping needs
  signing, which is Phase 4.
- **Deposit-address keys do not exist yet.** Phase 2 derives addresses and never
  signs, so no key material is stored. ADR-0005 commits to how those keys will
  be held when Phase 4 needs them.
- **SOL only.** SPL tokens bring Associated Token Accounts, per-mint rent, and
  fee funding — all of which are sweep and withdrawal problems, so they arrive
  with Phase 4 (ADR-0008).
- **The Solana SDK loses precision above 2^53 lamports** (~9M SOL). It does not
  affect a single user's deposit address; it would affect a hot wallet. The fix
  is a bigint-aware RPC transport.
- **Reconciliation cannot detect a deposit credited to the wrong user.** The
  totals would still match. Attribution correctness rests on address uniqueness
  (ADR-0004) and is covered by tests, not by that report.
- **No operator tooling for adjustments.** A genuine correction requires a
  reversing ledger transaction, and there is no UI or CLI for one. If an
  incident needs it, that is a finding for Phase 4's operational controls.

## Known limitations

- **Registration is enumerable.** Login is not (and is tested). Registering an
  email that already exists returns a conflict, which confirms it exists. The
  fix needs email delivery, which is out of Phase 1 scope. Deliberate and
  recorded — see ADR-0002.
- **No account recovery.** Lose every passkey and the account is unreachable.
  Recovery codes cover the TOTP factor only. This must be built before the
  system holds anything valuable.
- **`TOTP_ENCRYPTION_KEY` cannot be rotated.** No re-encryption tooling exists;
  changing it orphans every enrolled authenticator.
- **Secrets live in `.env` locally.** A real secret manager is Phase 4
  (master-prompt rule 157).
- **`NODE_ENV` must not be `development` for a production build.** The web
  build script pins `NODE_ENV=production`; without it, Next.js fails while
  prerendering `/404` with an error that names `pages/_document`, a file this
  project does not have.

## Next

Phase 3 — withdrawals, the risk engine, and a mock signer. See
[`report.md`](./report.md) §5.

The shape of it: a withdrawal state machine with explicit failure edges, a
deterministic policy engine that returns reason codes, fund locking as a
balanced transfer into `user_locked`, and a clearly-labelled mock `Signer`. The
mock is the point — it can be made to fail, hang, or time out on command, which
is how the retry and expiry paths get tested. Those paths are nearly impossible
to exercise against real MPC.

Two decisions to make before it starts: **durable nonce accounts versus recent
blockhashes** (a blockhash dies in ~60–90 seconds, and an MPC signing round plus
a manual review will exceed that — a dead blockhash mid-flight creates an
ambiguous "did it land?" state, which is the highest-consequence bug class in
the system), and how `requireStepUp` maps onto withdrawal value tiers.
