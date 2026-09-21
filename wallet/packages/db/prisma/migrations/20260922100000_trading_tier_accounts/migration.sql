-- The trading tier in the chart of accounts (ADR-0025, ADR-0032).
--
-- Two things happen here, and both are complete-or-not-at-all.
--
-- 1. The vault tier's accounts are renamed to name their tier. RENAME VALUE is
--    atomic and rewrites every existing row's value in place: no entry is
--    re-inserted, which matters because ledger_entries and ledger_transactions
--    are append-only and the triggers would refuse an UPDATE.
--
--    No function, trigger or view refers to these values by string — the
--    ledger triggers are shape-based (balance, cluster), not type-based — so
--    nothing is left pointing at a name that no longer exists.
--
-- 2. Four account types and four transaction kinds are added. `BEFORE` keeps
--    the database's value order identical to schema.prisma, which is itself
--    GENERATED from ACCOUNT_TYPES / TRANSACTION_KINDS in packages/ledger.
--
-- ADD VALUE may run inside a transaction on PostgreSQL 12+ provided the new
-- value is not USED in the same transaction. Nothing below uses them.

ALTER TYPE "LedgerAccountType" RENAME VALUE 'user_available' TO 'user_custody_available';
ALTER TYPE "LedgerAccountType" RENAME VALUE 'user_locked'    TO 'user_custody_locked';

ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'user_trading_available' BEFORE 'chain_assets';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'user_order_locked'      BEFORE 'chain_assets';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'clearing_assets'        BEFORE 'chain_assets';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'house_trading_fees'     BEFORE 'chain_assets';

-- `trade_settle` is deliberately absent: S4 adds it with the posting that
-- produces it, so a kind never exists without a producer.
ALTER TYPE "LedgerTransactionKind" ADD VALUE IF NOT EXISTS 'allocation'    BEFORE 'adjustment';
ALTER TYPE "LedgerTransactionKind" ADD VALUE IF NOT EXISTS 'deallocation'  BEFORE 'adjustment';
ALTER TYPE "LedgerTransactionKind" ADD VALUE IF NOT EXISTS 'order_hold'    BEFORE 'adjustment';
ALTER TYPE "LedgerTransactionKind" ADD VALUE IF NOT EXISTS 'order_release' BEFORE 'adjustment';
