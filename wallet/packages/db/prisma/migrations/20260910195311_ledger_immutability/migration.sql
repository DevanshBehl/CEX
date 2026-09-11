-- The ledger is append-only and every transaction balances, enforced by
-- PostgreSQL rather than by application code.
-- prompt_phase2.md rules 131-137, master-prompt rules 113, 116.
--
-- This is the same mechanism proven on audit_log in Phase 1, applied verbatim
-- (rule 133). Building it there first — against a table where a mistake cost an
-- audit trail rather than someone's balance — is the entire reason it can be
-- applied here with confidence.
--
-- Everything below is idempotent so re-running is safe.

-- ---------------------------------------------------------------------------
-- 1. Baseline grants for the new tables.
--
-- ALTER DEFAULT PRIVILEGES from the Phase 1 grants migration covers tables
-- created after it ran, but stating them explicitly costs nothing and makes
-- this migration self-contained if the earlier one is ever squashed.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "wallets"          TO wallet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "addresses"        TO wallet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "deposits"         TO wallet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "indexer_cursors"  TO wallet_app;
GRANT SELECT, INSERT                 ON TABLE "ledger_accounts"  TO wallet_app;

-- ---------------------------------------------------------------------------
-- 2. The ledger is append-only.
--
-- wallet_app may read and append. It may not rewrite history, and neither may
-- anything else: the triggers below stop wallet_owner and a superuser too, so
-- a migration or a psql session cannot quietly correct a balance.
--
-- A genuine correction is an ADJUSTMENT transaction — new entries that reverse
-- the old ones, leaving both visible. That is what an auditable ledger means.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ledger_entries"       FROM wallet_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ledger_transactions"  FROM wallet_app;
GRANT  SELECT, INSERT            ON TABLE "ledger_entries"      TO   wallet_app;
GRANT  SELECT, INSERT            ON TABLE "ledger_transactions" TO   wallet_app;

CREATE OR REPLACE FUNCTION ledger_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Post a reversing adjustment transaction instead (prompt_phase2.md rules 78, 131-133).',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_no_update ON "ledger_entries";
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

DROP TRIGGER IF EXISTS ledger_entries_no_delete ON "ledger_entries";
CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

DROP TRIGGER IF EXISTS ledger_transactions_no_update ON "ledger_transactions";
CREATE TRIGGER ledger_transactions_no_update
  BEFORE UPDATE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

DROP TRIGGER IF EXISTS ledger_transactions_no_delete ON "ledger_transactions";
CREATE TRIGGER ledger_transactions_no_delete
  BEFORE DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

-- ---------------------------------------------------------------------------
-- 3. Structural constraints on an entry.
-- ---------------------------------------------------------------------------

-- The sign lives in `direction`; a negative amount would be a second, possibly
-- disagreeing, representation of the same movement (rule 77).
ALTER TABLE "ledger_entries"
  DROP CONSTRAINT IF EXISTS ledger_entries_amount_positive;
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT ledger_entries_amount_positive CHECK (amount > 0);

-- An entry names its asset and so does its account. If they disagree, one is
-- wrong and there is no way to tell which, so the database refuses the pair.
CREATE OR REPLACE FUNCTION ledger_entry_asset_matches_account()
RETURNS TRIGGER AS $$
DECLARE
  account_asset TEXT;
BEGIN
  SELECT asset INTO account_asset FROM "ledger_accounts" WHERE id = NEW.account_id;
  IF account_asset IS DISTINCT FROM NEW.asset THEN
    RAISE EXCEPTION
      'ledger entry asset "%" does not match account asset "%" (prompt_phase2.md rule 80)',
      NEW.asset, account_asset
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_asset_matches ON "ledger_entries";
CREATE TRIGGER ledger_entries_asset_matches
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_asset_matches_account();

-- ---------------------------------------------------------------------------
-- 4. Every transaction balances, per asset, checked at COMMIT.
--
-- DEFERRED is required, not stylistic (rule 135): entries are inserted one at
-- a time, so every intermediate state is legitimately unbalanced. A non-deferred
-- constraint would reject the first entry of every valid transaction.
--
-- This duplicates the check in packages/ledger's buildTransaction on purpose.
-- The application check produces a comprehensible error at the call site; this
-- one is the guarantee, and it holds for raw SQL, a migration, and any future
-- code path that forgets to use the builder.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_transaction_balances()
RETURNS TRIGGER AS $$
DECLARE
  offending RECORD;
  entry_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO entry_count
  FROM "ledger_entries" WHERE transaction_id = NEW.transaction_id;

  -- One entry cannot balance against anything. Double-entry is the point.
  IF entry_count < 2 THEN
    RAISE EXCEPTION
      'ledger transaction % has % entr(y|ies); a transaction needs at least two (prompt_phase2.md rule 81)',
      NEW.transaction_id, entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  -- Balance is checked PER ASSET, not in aggregate (rule 79). A transaction
  -- that is +1 SOL and -1 USDC sums to zero only if the two are treated as
  -- interchangeable, which is exactly the error worth preventing.
  FOR offending IN
    SELECT asset,
           SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS residual
    FROM "ledger_entries"
    WHERE transaction_id = NEW.transaction_id
    GROUP BY asset
    HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0
  LOOP
    RAISE EXCEPTION
      'ledger transaction % does not balance for asset %: residual % (master-prompt rule 116)',
      NEW.transaction_id, offending.asset, offending.residual
      USING ERRCODE = 'check_violation';
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_balance_check ON "ledger_entries";
CREATE CONSTRAINT TRIGGER ledger_entries_balance_check
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_transaction_balances();
