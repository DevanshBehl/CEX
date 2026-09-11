-- The withdrawal state machine, enforced by the database.
-- prompt_phase3.md rules 97-102, master-prompt rule 137.
--
-- GENERATED FROM packages/types/src/withdrawal-states.ts.
--
-- The transition table is declared once, in TypeScript, and this migration is
-- derived from it. Hand-writing the pairs here would create a second source of
-- truth that drifts from the first the moment someone edits one and forgets the
-- other — and the drift would be invisible until a legal transition was refused
-- in production.
--
-- The type system stops code that goes through the domain. This stops raw SQL,
-- a migration, and a psql session (rule 99).

-- ---------------------------------------------------------------------------
-- 1. withdrawal_transitions is append-only.
--
-- Same mechanism as ledger_entries and audit_log: the grant removes the verbs
-- from the application role, and the triggers stop the schema owner too.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "withdrawals"     TO wallet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "nonce_accounts"  TO wallet_app;
GRANT SELECT, INSERT, UPDATE         ON TABLE "signing_requests" TO wallet_app;
GRANT SELECT, INSERT                 ON TABLE "risk_decisions"  TO wallet_app;
GRANT SELECT, INSERT                 ON TABLE "withdrawal_transitions" TO wallet_app;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "withdrawal_transitions" FROM wallet_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "risk_decisions"         FROM wallet_app;

CREATE OR REPLACE FUNCTION withdrawal_history_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. A withdrawal''s history is evidence (prompt_phase3.md rules 100-101).',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS withdrawal_transitions_no_update ON "withdrawal_transitions";
CREATE TRIGGER withdrawal_transitions_no_update
  BEFORE UPDATE ON "withdrawal_transitions"
  FOR EACH ROW EXECUTE FUNCTION withdrawal_history_is_append_only();

DROP TRIGGER IF EXISTS withdrawal_transitions_no_delete ON "withdrawal_transitions";
CREATE TRIGGER withdrawal_transitions_no_delete
  BEFORE DELETE ON "withdrawal_transitions"
  FOR EACH ROW EXECUTE FUNCTION withdrawal_history_is_append_only();

DROP TRIGGER IF EXISTS risk_decisions_no_update ON "risk_decisions";
CREATE TRIGGER risk_decisions_no_update
  BEFORE UPDATE ON "risk_decisions"
  FOR EACH ROW EXECUTE FUNCTION withdrawal_history_is_append_only();

-- ---------------------------------------------------------------------------
-- 2. Only legal transitions may be recorded.
--
-- A NULL from_status is the initial insert, which is always legal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION withdrawal_transition_is_legal()
RETURNS TRIGGER AS $$
DECLARE
  legal BOOLEAN;
BEGIN
  IF NEW.from_status IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM (VALUES
    ('REQUESTED', 'RISK_EVALUATING'),
    ('RISK_EVALUATING', 'APPROVED'),
    ('RISK_EVALUATING', 'MANUAL_REVIEW'),
    ('RISK_EVALUATING', 'REJECTED'),
    ('MANUAL_REVIEW', 'APPROVED'),
    ('MANUAL_REVIEW', 'REJECTED'),
    ('APPROVED', 'FUNDS_LOCKED'),
    ('APPROVED', 'REJECTED'),
    ('FUNDS_LOCKED', 'SIGNING'),
    ('FUNDS_LOCKED', 'REJECTED'),
    ('FUNDS_LOCKED', 'FAILED'),
    ('SIGNING', 'SIGNED'),
    ('SIGNING', 'SIGN_FAILED'),
    ('SIGNED', 'BROADCAST'),
    ('BROADCAST', 'CONFIRMED'),
    ('BROADCAST', 'BROADCAST_FAILED'),
    ('BROADCAST', 'EXPIRED'),
    ('CONFIRMED', 'SETTLED'),
    ('SIGN_FAILED', 'FUNDS_LOCKED'),
    ('SIGN_FAILED', 'FAILED'),
    ('BROADCAST_FAILED', 'FUNDS_LOCKED'),
    ('BROADCAST_FAILED', 'FAILED'),
    ('EXPIRED', 'FUNDS_LOCKED'),
    ('EXPIRED', 'FAILED')
    ) AS t(from_status, to_status)
    WHERE t.from_status = NEW.from_status::text
      AND t.to_status   = NEW.to_status::text
  ) INTO legal;

  IF NOT legal THEN
    RAISE EXCEPTION
      'illegal withdrawal transition % -> % (prompt_phase3.md rule 98)',
      NEW.from_status, NEW.to_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS withdrawal_transitions_legal ON "withdrawal_transitions";
CREATE TRIGGER withdrawal_transitions_legal
  BEFORE INSERT ON "withdrawal_transitions"
  FOR EACH ROW EXECUTE FUNCTION withdrawal_transition_is_legal();

-- ---------------------------------------------------------------------------
-- 3. Structural constraints.
-- ---------------------------------------------------------------------------
ALTER TABLE "withdrawals" DROP CONSTRAINT IF EXISTS withdrawals_amount_positive;
ALTER TABLE "withdrawals" ADD CONSTRAINT withdrawals_amount_positive CHECK (amount > 0);

ALTER TABLE "withdrawals" DROP CONSTRAINT IF EXISTS withdrawals_fee_non_negative;
ALTER TABLE "withdrawals"
  ADD CONSTRAINT withdrawals_fee_non_negative CHECK (network_fee IS NULL OR network_fee >= 0);

-- Retry counts are budgets, not tallies that can go backwards.
ALTER TABLE "withdrawals" DROP CONSTRAINT IF EXISTS withdrawals_attempts_non_negative;
ALTER TABLE "withdrawals" ADD CONSTRAINT withdrawals_attempts_non_negative
  CHECK (sign_attempts >= 0 AND broadcast_attempts >= 0 AND expiry_attempts >= 0);

-- A nonce account serves ONE in-flight withdrawal (prompt_phase3.md rule 38).
-- Two withdrawals on one nonce produce two transactions where only one can win,
-- and the loser's failure is indistinguishable from an expiry.
CREATE UNIQUE INDEX IF NOT EXISTS nonce_accounts_one_lease
  ON "nonce_accounts" (leased_by)
  WHERE leased_by IS NOT NULL;

-- A leased nonce account must name its lessee, and an available one must not.
ALTER TABLE "nonce_accounts" DROP CONSTRAINT IF EXISTS nonce_accounts_lease_consistent;
ALTER TABLE "nonce_accounts" ADD CONSTRAINT nonce_accounts_lease_consistent CHECK (
  (status = 'leased'     AND leased_by IS NOT NULL) OR
  (status <> 'leased'    AND leased_by IS NULL)
);
