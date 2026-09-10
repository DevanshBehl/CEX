# MPC Custodial Wallet

An educational custodial Solana wallet platform, built in four phases.
**This is Phase 1: foundations and identity.**

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

## What Phase 1 does

A person can create an account with a passkey, sign in with no password and no
seed phrase, manage their passkeys and sessions, and turn on two-factor
authentication — over a typed, validated, correlated, rate-limited API.

## What Phase 1 deliberately does NOT do

There are **no wallets, no addresses, no balances, no deposits, no
withdrawals, and no monetary column anywhere in the schema.** Money is designed
in Phase 2 together with the double-entry ledger that governs it. A `balance`
column added here as a shortcut becomes an accounting bug there
(prompt_phase1.md rules 22, 205).

The dashboard says it has nothing to show, because it has nothing to show. It
does not display a plausible-looking number — in a wallet, a fake balance is
worse than no balance.

## Quick start

```bash
cp .env.example .env
openssl rand -base64 48   # -> SESSION_SECRET in .env
openssl rand -base64 32   # -> TOTP_ENCRYPTION_KEY in .env

pnpm install
pnpm infra:up                              # PostgreSQL :5433, Redis :6380
pnpm --filter @wallet/db generate
pnpm --filter @wallet/db migrate:deploy
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
  api/    Fastify — routes → controllers → services → repositories
  web/    Next.js — pages, feature folders, one typed API client
packages/
  types/  Zod schemas — the single source of truth for every contract
  config/ the ONLY place process.env is read
  logger/ structured JSON, correlation IDs, allowlist redaction
  errors/ typed hierarchy with stable, client-facing codes
  db/     Prisma schema, migrations, repositories, transaction helper
  auth/   WebAuthn, sessions, TOTP, step-up, CSRF
infra/    docker-compose: PostgreSQL + Redis
scripts/  verify-boundaries.mjs — proves the lint rules actually bite
```

There is no `packages/ledger`, `packages/solana`, or `services/mpc` yet. Empty
packages rot and misrepresent the architecture, so they arrive with the phase
that needs them.

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

## Testing

164 tests: 107 unit, 50 integration, 7 end-to-end.

```bash
pnpm test              # unit — no infrastructure needed
pnpm test:integration  # against real PostgreSQL, never a mock or SQLite
pnpm test:e2e          # Playwright, real WebAuthn via a virtual authenticator
node scripts/verify-boundaries.mjs
```

Integration tests run against real PostgreSQL because what they assert — role
grants, an append-only trigger, transaction rollback, unique constraints — are
properties of Postgres, not of the repository code. A mock would pass while
proving nothing.

## What the tests actually caught

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

Phase 2 — custody primitives and money-in, specified in
[`prompt_phase2.md`](./prompt_phase2.md). It ends with SOL that can arrive and
be accounted for, but cannot leave: deposits need no signing, so the ledger gets
proven correct before any key material exists.

Five ADRs block the first line of Phase 2 code (§2 of that document). The
deposit-address model is the one that matters most — it determines the indexer
design, the sweep economics, and the eventual MPC key count, so deciding it
late means rework across two phases.
