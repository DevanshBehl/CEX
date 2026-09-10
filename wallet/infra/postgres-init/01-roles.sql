-- Least-privilege database roles (prompt_phase1.md rules 107-109).
--
--   wallet_owner  owns the schema and runs migrations. Used by the Prisma CLI.
--   wallet_app    is what the API connects as. It can read and write rows but
--                 cannot alter structure, and — see 02-grants.sql, applied
--                 after migrations — cannot UPDATE or DELETE audit_log.
--
-- Splitting these is what makes append-only enforceable by the database rather
-- than by everyone remembering not to write the wrong query. Phase 2 reuses
-- this exact mechanism for ledger_entries.

-- CREATEDB is needed for Prisma's shadow database during `migrate dev`.
-- It is a local-development convenience; a deployed owner role would not have it.
CREATE ROLE wallet_owner WITH LOGIN CREATEDB PASSWORD 'wallet_owner';
CREATE ROLE wallet_app   WITH LOGIN PASSWORD 'wallet_app';

ALTER DATABASE wallet OWNER TO wallet_owner;

\connect wallet

-- The public schema belongs to the migration owner; the app role only uses it.
ALTER SCHEMA public OWNER TO wallet_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO wallet_app;
GRANT CREATE, USAGE ON SCHEMA public TO wallet_owner;

-- Anything wallet_owner creates later is automatically readable/writable by
-- wallet_app. 02-grants.sql then claws back audit_log.
ALTER DEFAULT PRIVILEGES FOR ROLE wallet_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wallet_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wallet_app;
