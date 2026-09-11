# MPC Custodial Wallet

An educational custodial Solana wallet platform, built in four phases.
**Phases 1–3 are complete: identity, custody and money-in, and money-out.
Phase 4 is partially complete** — see [Where Phase 4 stands](#where-phase-4-stands).

> Not audited. Not production custody. Never point this at real funds.
> — master-prompt rules 7–8

| Document                                                           | What it is                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| [`master-prompt.md`](./master-prompt.md)                           | The 200-rule specification for the whole system             |
| [`report.md`](./report.md)                                         | The four-phase build plan and system design                 |
| [`prompt_phase1.md`](./prompt_phase1.md)                           | The 210-rule implementation contract for Phase 1 (complete) |
| [`prompt_phase2.md`](./prompt_phase2.md)                           | The 228-rule implementation contract for Phase 2 (complete) |
| [`prompt_phase3.md`](./prompt_phase3.md)                           | The 233-rule implementation contract for Phase 3 (complete) |
| [`prompt_phase4.md`](./prompt_phase4.md)                           | The 267-rule implementation contract for Phase 4 (partial)  |
| [`docs/adr/`](./docs/adr)                                          | Decisions and the trade-offs behind them                    |
| [`docs/runbooks/`](./docs/runbooks)                                | Incident procedures and local setup                         |
| [`docs/security/threat-model.md`](./docs/security/threat-model.md) | What is defended, and what is not                           |

## What works today

A person can create an account with a passkey, sign in with no password and no
seed phrase, and manage their passkeys, sessions and two-factor authentication.
They can get a Solana deposit address, send SOL to it, and watch it appear in
their balance. They can then withdraw it — through risk checks, fund locking, a
signature, a broadcast, and ledger settlement — with every state of that journey
shown honestly.

All of it recorded in a double-entry ledger the database itself refuses to let
anyone falsify.

## Where Phase 4 stands

**Signing is real, and it is a single key.**

`services/mpc` is a separate Rust process holding the signing key, reached over
an authenticated channel. It verifies an approval proof bound to the exact
payload before it will sign, enforces per-request idempotency, and enforces
custody-tier authority requirements. The key never leaves it: no endpoint
returns it, no log prints it, and the type that holds it has no accessor.

**It is not threshold signing.** ADR-0015 specifies 3-of-5 FROST-Ed25519 across
independent failure domains. What exists is one key in one process. That
delivers the process boundary and the authorization check — most of the
architectural value — and **none** of the key-compromise resistance. One host
compromise yields the treasury key.

| Phase 4 area                      | State                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Rust signing service (4a)         | **done** — TLS, authenticated, idempotent, tier-aware                                    |
| 3-of-5 FROST threshold (4b)       | **not started**                                                                          |
| SPL token allowlist and deposits  | **done** — mints allowlisted, unknown mints recorded not credited                        |
| SPL token withdrawals and sweeps  | **not started** — fee funding and the sweep lifecycle remain                             |
| Custody tiers                     | **policy done and enforced in the signer**; no tier addresses yet                        |
| Per-asset risk limits             | **done** — an asset with no configured limits is not withdrawable                        |
| Reconciliation as a job           | **done** — scheduled, covers nonce accounts and the treasury, alerts on persistent drift |
| Metrics and dead-letter queue     | **done** — operator endpoints, no user ids or amounts as labels                          |
| Threat model and dependency audit | **done** — [threat model](./docs/security/threat-model.md), enforced audit policy        |
| Secret manager, operator roles    | **not started** — `.env` and a list of user ids                                          |

Still absent by design: a second chain (ADR-0019 describes what one would
touch, and nothing implements it).

The mock signer still exists for tests. It announces itself on every call and
refuses to construct when `NODE_ENV` is `production` — twice over, since the
config refuses `SIGNER_KIND=mock` there as well. The retry, timeout, expiry and
ambiguous-broadcast paths are where withdrawals actually go wrong and are nearly
impossible to provoke against a real signer, so the mock earns its place. CI
runs the entire Phase 3 suite against the **real** service as well, and fails if
that service signed nothing.

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
  risk/       the withdrawal policy engine — pure, deterministic, replayable
  blockchain/ chain-agnostic interfaces, plus the mock signer
  solana/     the only package allowed to import a Solana SDK
infra/        docker-compose: PostgreSQL + Redis
scripts/      verify-boundaries.mjs — proves the lint rules actually bite
```

Every TypeScript package now exists. Phase 4's addition is `services/mpc`, which
is Rust and so cannot be reached by an import at all — `verify-boundaries.mjs`
still checks that the domain packages stay free of chains, databases and
frameworks.

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

**The house pre-funds its own fees.** Network fees are paid from the same
on-chain pool that holds user funds, so a platform that debits `house_fees`
without having put anything in is paying its operating costs out of customer
money. The `liabilities_covered` invariant catches that immediately — it was the
first thing it caught once withdrawals could pay a fee. `house_fees` is a
prepaid balance and may never go negative.

## The withdrawal lifecycle

```
REQUESTED → RISK_EVALUATING → { REJECTED | MANUAL_REVIEW | APPROVED }
MANUAL_REVIEW    → { REJECTED | APPROVED }
APPROVED         → FUNDS_LOCKED
FUNDS_LOCKED     → SIGNING → { SIGNED | SIGN_FAILED }
SIGNED           → BROADCAST → { CONFIRMED | BROADCAST_FAILED | EXPIRED }
CONFIRMED        → SETTLED
SIGN_FAILED | BROADCAST_FAILED | EXPIRED → FUNDS_LOCKED  (bounded retry)
                                         → FAILED        (budget exhausted)
```

Fifteen states, twenty-four legal transitions, declared once in
`packages/types/src/withdrawal-states.ts`. The migration that enforces them is
**generated from that same table**, so the constraint and the type cannot drift
— and both are tested, illegal transitions and legal ones alike.

**Every failure edge is a state, not an exception.** A withdrawal that fails is
_somewhere_, with a reason, and its full history is in `withdrawal_transitions`,
which is append-only for the application role and for the schema owner.

**A lock is a balanced transfer**, `user_available → user_locked`, posted in the
same database transaction as the state change — so the ledger and the machine
can never disagree. It is also the sufficient-funds check, because the check and
the reservation have to be one atomic act: two concurrent withdrawals can each
pass a balance check and both proceed, but only one can win the ledger write.

### Durable nonces, and why they are not a detail

A Solana recent blockhash dies in 60–90 seconds. A withdrawal passes through
risk evaluation, possibly a human approval queue, a signing round, and a
broadcast — and in Phase 4 that signing round is threshold MPC across several
machines. It will not reliably finish inside 90 seconds.

A blockhash that expires mid-flight produces the **ambiguous broadcast**: signed,
submitted, and nobody can say whether it landed. Re-signing risks a double-spend;
doing nothing strands the funds. There is no third option, because a dead
blockhash carries no evidence.

Every withdrawal is therefore built on a **durable nonce account**, which gives
one property nothing else does:

> The nonce advancing exactly once is proof the transaction landed exactly once.

Re-broadcasting identical bytes is always safe. Re-signing happens only after
reading the nonce shows the old transaction can never land. See
[ADR-0009](./docs/adr/0009-durable-nonce-accounts.md) and the
[ambiguous-broadcast runbook](./docs/runbooks/ambiguous-broadcast.md).

## The risk engine

`packages/risk` is pure: no database, no clock, no chain, no configuration read.
Everything it needs is an argument, including `now` — so the same input always
produces the same decision, and a decision persisted today can be replayed years
from now and explain itself.

Seven rules run on **every** evaluation. No short-circuit on the first denial,
because an operator resolving a review needs everything that was wrong, not the
first thing.

| Rule                                    | Verdict when it fires |
| --------------------------------------- | --------------------- |
| account state                           | deny                  |
| destination valid / on-curve / not ours | deny                  |
| per-transaction limit                   | deny                  |
| rolling 24h limit                       | deny                  |
| velocity (count in a window)            | deny                  |
| first-time destination                  | **review**            |
| above the review threshold              | **review**            |

**The daily window rolls.** A calendar reset would let an attacker take a full
limit at 23:59 and another at 00:01.

**A new destination is reviewed, not denied.** It is the shape of an account
takeover — and also the shape of every legitimate first withdrawal.

**The client is told a denial happened and a generic reason; never which limit,
never by how much.** Returning the specific limit turns the endpoint into an
oracle for probing thresholds. The full codes go to the persisted decision and
to the operator queue.

## Testing

441 tests: 264 unit, 153 integration, 24 end-to-end.

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

### Phase 3

**1. Paying network fees out of the pooled assets is paying them with customer
money.** The `liabilities_covered` invariant fired the first time a settlement
charged a fee — total user liabilities exceeded chain-controlled assets by
exactly the fee. The accounting was right and the _design_ was wrong: the house
has to pre-fund its own operating balance, like any other participant.
`house_fees` is now a prepaid balance that may never go negative.

**2. Catching a constraint violation inside a PostgreSQL transaction poisons
it.** Carried forward from Phase 2 as a written rule, and it still had to be
applied deliberately to withdrawal idempotency keys — `ON CONFLICT DO NOTHING`,
never `try/catch`.

**3. The withdrawal route borrowed the auth rate limit.** The two exist for
different reasons: auth limits slow credential guessing, a withdrawal limit
bounds a compromised session, and the risk engine's velocity rule is the real
control there. The integration suite tripped over it immediately.

**4. A hardcoded global rate limit made the E2E suite fail on unrelated
assertions.** Two dozen browser journeys from one IP exceeded 300/min,
`/auth/session` was throttled, and the app correctly concluded the user was
signed out — so the failures pointed at the pages rather than at the limit. It
is configuration now.

**5. Test data accumulating across runs crowded out the worker batch.** Every
run left withdrawals in `BROADCAST` that nothing would ever finalize; they piled
up until a cycle appeared to do nothing. The fix is test hygiene, but the
diagnosis took a while because the symptom looked like a worker bug.

**6. Deleting a test user fails once it has withdrawal history — and that is the
system working.** The cascade reaches `withdrawal_transitions`, which is
append-only, so the delete is refused. Cleanup now removes only users who left
no evidence behind. Test data accumulating is the honest price of history that
cannot be quietly edited.

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

## Known limitations (Phase 3)

- **The signer is a mock.** It produces signatures that verify against nothing.
  Two independent guards stop it reaching production: the config refuses
  `SIGNER_KIND=mock` there, and `MockSigner` refuses to construct. Real
  threshold signing is Phase 4.
- **`SIGNER_KIND=real` throws.** It exists in the schema so a production
  configuration is expressible; nothing implements it yet, and failing loudly
  beats silently falling back to the mock.
- **No operator role model.** The review queue is gated by a configured list of
  user ids plus a step-up. A real role model is Phase 4 (ADR-0011).
- **The nonce pool is a fixed size.** It bounds withdrawal concurrency, and a
  dry pool makes withdrawals wait rather than fail. Growing it on demand is
  Phase 4.
- **Reconciliation does not observe nonce accounts or the treasury.** Their
  balances are outside the comparison, so the residual is approximate while
  withdrawals are in flight.
- **No operator tooling for adjustments.** A lock that somehow outlives its
  withdrawal needs a reversing ledger transaction, and there is no UI or CLI for
  one.
- **Address allowlisting is not built.** Master-prompt rule 150 calls it a
  future feature; the policy engine is shaped so it drops in without
  restructuring.

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
  changing it orphans every enrolled authenticator. Accepted and recorded rather
  than fixed (prompt_phase4.md rule 167).
- **Secrets live in `.env`.** A real secret manager remains unbuilt
  (master-prompt rule 157). The deposit master seed is the sharpest edge here:
  it can regenerate every deposit key and lives in the API process's
  environment. See the [threat model](./docs/security/threat-model.md).
- **`NODE_ENV` must not be `development` for a production build.** The web
  build script pins `NODE_ENV=production`; without it, Next.js fails while
  prerendering `/404` with an error that names `pages/_document`, a file this
  project does not have.

## Next

**What remains of Phase 4**, in the order `prompt_phase4.md` rule 16 recommends
— everything else before 4b, because the single-key service already delivers the
process boundary and blocking tokens and operations behind threshold crypto
stalls everything on the hardest piece.

1. **SPL token withdrawals and sweeps.** Deposits work; money-out does not. A
   token cannot pay its own fee, so a funding step must precede any token
   movement out of a deposit address (ADR-0016), and a sweep reuses the
   withdrawal lifecycle rather than duplicating it (ADR-0017).
2. **Custody tier addresses.** The policy is written and enforced in the signing
   service; hot, warm and cold have no addresses or rebalancing yet (ADR-0018).
3. **Secret manager and an operator role model.** `.env` and
   `OPERATOR_USER_IDS` are what exist. The deposit master seed and the KEK move
   first — they are the values that regenerate everything else.
4. **4b — threshold signing.** **3-of-5 FROST-Ed25519** (RFC 9591) via
   `frost-ed25519`, never a hand-rolled scheme — see
   [ADR-0015](./docs/adr/0015-threshold-parameters.md). It produces an ordinary
   Ed25519 signature, so nothing on-chain changes. Tolerates two participants
   being unavailable; requires three to collude.

Two things in ADR-0015 matter more than the parameters. **A participant is a
separate host**, because five processes on one machine are five copies of one
blast radius — the threshold is arithmetic, the independence is the security.
And **each participant independently verifies the `AuthorizationProof`** before
contributing a share: one that blindly signs whatever the coordinator hands it
protects against key theft and nothing else, since a compromised API could
simply ask for a signature paying an attacker. That verification is already
implemented in the single-key service, ahead of 4b, because it has exactly the
same exposure.

A second chain is **design only** and stays that way
([ADR-0019](./docs/adr/0019-second-chain-seams.md)).
