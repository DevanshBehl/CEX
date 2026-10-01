-- The clearing tier's withdrawal lock, and one release per order
-- (ADR-0032 addendum, prompt_phase_s4.md §8).

-- 1. `user_trading_locked` — funds reserved against a pending deallocation.
--
-- A deallocation's coins stay at the CLEARING address while it is in flight, so
-- its liability must stay locked in the clearing tier. `user_order_locked` is
-- not that account: it must equal the sum of outstanding order holds, which is
-- what reconciliation compares against the book.
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'user_trading_locked' BEFORE 'clearing_assets';

-- 2. An order's hold is released EXACTLY ONCE, at its terminal event.
--
-- S3 releases from three places — a business rejection in the gateway's
-- response, a cancel, and the PENDING_ENGINE sweeper's FAILED path — and S4's
-- settlement worker adds a fourth. Whoever gets there first posts it; everyone
-- after is refused by this index, which is what makes it safe for more than
-- one path to try. Partial fills CONSUME a hold and never release it, so one
-- release per order is a true invariant rather than a simplification.
--
-- PARTIAL, never global: one withdrawal already produces two or three ledger
-- transactions sharing (reference_type, reference_id).
CREATE UNIQUE INDEX IF NOT EXISTS ledger_transactions_order_release_uniq
  ON ledger_transactions (reference_id) WHERE kind = 'order_release';
