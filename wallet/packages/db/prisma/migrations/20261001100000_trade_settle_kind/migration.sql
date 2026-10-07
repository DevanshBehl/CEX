-- `trade_settle`: one settled fill (ADR-0034 §3).
--
-- ALONE in its migration, deliberately. PostgreSQL refuses to use an enum value
-- in the transaction that added it ("unsafe use of new value"), and the partial
-- unique index that makes settlement idempotent names this value in its WHERE
-- clause. That index is in the next migration.
ALTER TYPE "LedgerTransactionKind" ADD VALUE IF NOT EXISTS 'trade_settle';
