-- Least-privilege grants, and audit_log made append-only at the DATABASE level.
-- prompt_phase1.md rules 106-109, master-prompt rules 156, 166.
--
-- WHY THIS IS A MIGRATION AND NOT ONLY A CONTAINER INIT SCRIPT
--
-- It started life in infra/postgres-init/, which runs once when the Postgres
-- volume is first created. Then `prisma migrate reset` dropped and recreated
-- schema public — and every schema-scoped GRANT and ALTER DEFAULT PRIVILEGES
-- went with it, silently. The app role could no longer see its own tables, and
-- nothing said so until a query failed with "relation does not exist".
--
-- Roles are cluster-scoped and survive a schema drop; grants are not. So role
-- CREATION stays in the init script, and everything schema-scoped lives here,
-- where it is re-applied on every reset and every fresh deploy.
--
-- Everything below is idempotent so re-running is safe.

-- ---------------------------------------------------------------------------
-- 1. Baseline access for the application role.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO wallet_app;

-- Tables that already exist at this point in the migration history.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wallet_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wallet_app;

-- Tables created by later migrations, automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE wallet_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wallet_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wallet_app;

-- ---------------------------------------------------------------------------
-- 2. audit_log is append-only. wallet_app may read and append; it may not
--    rewrite history.
--
--    Enforcing this in SQL rather than in a repository method matters because
--    an application-level guarantee is only as good as every future query
--    someone writes. This one survives a bug, a rogue script, and a
--    well-meaning "let me just clean up those test rows".
--
--    Phase 2's ledger_entries reuses this verbatim. Proving the mechanism on a
--    table where a mistake costs an audit trail rather than someone's balance
--    is exactly why it is built in Phase 1.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log" FROM wallet_app;
GRANT SELECT, INSERT ON TABLE "audit_log" TO wallet_app;

-- Defence in depth: a trigger, so the rule also holds for wallet_owner and for
-- a superuser, neither of which the grant above constrains. A deliberate
-- retention policy would have to DROP this trigger in a reviewed migration.
-- That friction is the feature.
CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: % is not permitted (prompt_phase1.md rules 106-108)',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON "audit_log";
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

DROP TRIGGER IF EXISTS audit_log_no_delete ON "audit_log";
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------------------
-- 3. No DDL for the application role. Structure changes require wallet_owner,
--    which only the Prisma CLI connects as (rule 109).
-- ---------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM wallet_app;
