# ADR-0003: Two database roles, and append-only enforced by the database

- **Status:** accepted
- **Date:** 2026-09-10
- **Phase:** 1

## Context

prompt_phase1.md rules 106-109 require `audit_log` to be append-only, enforced
at the database level, and require the application to run with least privilege.
The real target is Phase 2: `ledger_entries` must be immutable, and an
immutability guarantee that depends on every developer remembering not to write
`UPDATE` is not a guarantee.

## Decision

Two roles:

| Role           | Used by                     | Can                                                                 |
| -------------- | --------------------------- | ------------------------------------------------------------------- |
| `wallet_owner` | Prisma CLI, migrations only | own and alter the schema                                            |
| `wallet_app`   | the API                     | read/write rows; **no DDL**; **no UPDATE or DELETE on `audit_log`** |

Two layers of enforcement on `audit_log`:

1. `REVOKE UPDATE, DELETE, TRUNCATE ... FROM wallet_app` — stops the application.
2. `BEFORE UPDATE/DELETE` triggers that raise — stops `wallet_owner` and a
   superuser too.

Role _creation_ lives in `infra/postgres-init/01-roles.sql` (roles are
cluster-scoped). Everything schema-scoped lives in the
`grants_and_append_only_audit_log` migration.

## Why the split between init script and migration

This was originally all in the init script, which runs once when the Postgres
volume is first created. Then `prisma migrate reset` dropped and recreated
schema `public` — and every schema-scoped `GRANT` and `ALTER DEFAULT PRIVILEGES`
went with it, silently. The app role could no longer see its own tables, and
nothing said so until a query failed with "relation does not exist".

Roles survive a schema drop; grants do not. So grants belong in a migration,
where they are re-applied on every reset and every deploy.

## Alternatives considered

**Application-level immutability (a repository with no update method).** Free,
and it is also in place — `AuditLogRepository` exposes only `append`. Rejected
as the _only_ control because it protects against nothing but honest mistakes in
code that goes through the repository. Raw SQL, a migration, a psql session, or
a future developer bypass it entirely.

**Trigger only, no grant.** The trigger alone would work, but a permission
denial is cheaper than a raised exception and fails earlier, and having the
privilege simply absent is easier to audit than reading trigger bodies.

**Grant only, no trigger.** Leaves `wallet_owner` — which migrations run as —
able to rewrite history. The trigger closes that, and forces any real retention
policy to drop it explicitly in a reviewed migration. That friction is the
feature.

## Note on `process.env`

The Prisma CLI reads `MIGRATION_DATABASE_URL` from `.env` directly. This is the
single documented exception to rule 56 (`process.env` in exactly one file): it
is a separate process with its own configuration mechanism, and no application
TypeScript is involved. The ESLint rule covers `.ts` files and is unaffected.

## Consequences

- Local setup needs the init script to have run, which `docker compose up`
  handles. CI runs it explicitly.
- `wallet_owner` has `CREATEDB` locally so Prisma can provision a shadow
  database for `migrate dev`. A deployed owner role would not.
- Phase 2 reuses this migration verbatim for `ledger_entries`. Proving the
  mechanism on a table where a mistake costs an audit trail rather than
  someone's balance is exactly why it was built in Phase 1.
