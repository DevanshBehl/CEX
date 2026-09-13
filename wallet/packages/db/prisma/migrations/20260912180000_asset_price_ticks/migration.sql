-- Spot prices, for portfolio valuation (Task 3).
--
-- APPEND-ONLY, like the ledger and for the same reason: a portfolio chart is an
-- assertion about what someone's money was worth at a moment, and an assertion
-- whose inputs can be edited afterwards cannot be audited. A correction is a
-- NEW tick, never a rewritten one.
--
-- The append-only guarantee matters more here than it looks. A price row is the
-- only input to a valuation that does not come from the ledger, so it is the
-- only place a number on the dashboard could be changed without leaving a trace
-- anywhere else.

CREATE TABLE IF NOT EXISTS "asset_price_ticks" (
  "id"          BIGSERIAL PRIMARY KEY,
  -- A plain column rather than part of the asset key, unlike the ledger
  -- (ADR-0021). The reasoning there was that a query could accidentally SUM two
  -- clusters; a price is never summed, only looked up, and a narrower index
  -- matters more on a table that grows by one row per asset per minute.
  "cluster"     VARCHAR(32)  NOT NULL,
  -- The asset WITHOUT its cluster prefix: `SOL`, or a mint address.
  "asset"       VARCHAR(128) NOT NULL,
  -- NUMERIC, not DOUBLE PRECISION. `1.005` must come back as `1.005`, not as
  -- 1.0049999999999999, because it is multiplied by a balance and shown to
  -- someone as their money.
  "price_usd"   NUMERIC(18, 6) NOT NULL,
  -- Which feed said so. For the audit trail; never treated as authority.
  "source"      VARCHAR(32)  NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);

-- A price is not a balance, but zero and negative are both nonsense and both
-- would sail through a valuation and produce a plausible-looking number.
ALTER TABLE "asset_price_ticks" DROP CONSTRAINT IF EXISTS asset_price_ticks_price_positive;
ALTER TABLE "asset_price_ticks"
  ADD CONSTRAINT asset_price_ticks_price_positive CHECK ("price_usd" > 0);

-- The only access pattern: "the latest tick for this asset at or before T".
-- DESC on time so that scan stops at the first row.
CREATE INDEX IF NOT EXISTS "idx_asset_price_ticks"
  ON "asset_price_ticks" ("cluster", "asset", "recorded_at" DESC);

-- ---------------------------------------------------------------------------
-- Grants and immutability.
--
-- The same mechanism as `ledger_entries`: REVOKE for the application role and a
-- trigger that stops everyone else too, so a migration or a psql session cannot
-- quietly restate what an asset was worth last Tuesday.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "asset_price_ticks" FROM wallet_app;
GRANT  SELECT, INSERT            ON TABLE "asset_price_ticks" TO   wallet_app;
GRANT  USAGE, SELECT             ON SEQUENCE "asset_price_ticks_id_seq" TO wallet_app;

CREATE OR REPLACE FUNCTION price_ticks_are_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'asset_price_ticks is append-only: % is not permitted. Record a new tick instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS asset_price_ticks_no_update ON "asset_price_ticks";
CREATE TRIGGER asset_price_ticks_no_update
  BEFORE UPDATE ON "asset_price_ticks"
  FOR EACH ROW EXECUTE FUNCTION price_ticks_are_append_only();

DROP TRIGGER IF EXISTS asset_price_ticks_no_delete ON "asset_price_ticks";
CREATE TRIGGER asset_price_ticks_no_delete
  BEFORE DELETE ON "asset_price_ticks"
  FOR EACH ROW EXECUTE FUNCTION price_ticks_are_append_only();
