-- Cluster isolation (ADR-0021).
--
-- Devnet SOL and mainnet SOL are both "SOL". With no cluster dimension they
-- are the SAME ledger account: worthless testnet balances add to real ones
-- while every double-entry invariant still passes. Nothing is inconsistent —
-- it is simply wrong, and nothing reports an error.
--
-- A `cluster` COLUMN would fix that only if every query remembered to filter
-- on it, and forgetting silently sums clusters. Putting the cluster INSIDE the
-- key makes the mistake unrepresentable: there is no key that means "both".
--
-- This migration does three things:
--   1. qualifies every existing asset key and chain id with a cluster,
--   2. refuses unqualified ones from here on,
--   3. refuses any ledger transaction that touches two clusters.
--
-- It is idempotent: re-running it qualifies nothing twice.

-- ---------------------------------------------------------------------------
-- 0. Which cluster does the existing data belong to?
--
-- The database cannot know. Set it explicitly when deploying against data that
-- is NOT from a local validator:
--
--   ALTER DATABASE wallet SET wallet.backfill_cluster = 'devnet';
--
-- The default is `localnet`, because that is what every environment of this
-- project has run against, and because it is the reading that treats existing
-- balances as play money rather than as real money. Getting this wrong in the
-- other direction — labelling devnet dust as mainnet — is the expensive error.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target TEXT := COALESCE(NULLIF(current_setting('wallet.backfill_cluster', true), ''), 'localnet');
BEGIN
  IF target NOT IN ('localnet', 'devnet', 'testnet', 'mainnet-beta') THEN
    RAISE EXCEPTION 'wallet.backfill_cluster is "%", which is not a known cluster', target;
  END IF;
  RAISE NOTICE 'cluster backfill: existing rows will be qualified as "%"', target;
  -- Stashed for the statements below, which cannot each re-read a GUC that a
  -- caller may not have set.
  PERFORM set_config('wallet.resolved_backfill_cluster', target, false);
END $$;

-- ---------------------------------------------------------------------------
-- 1. A predicate, used by the backfill, the constraints and the trigger.
--
-- One definition, so "is this qualified?" cannot be answered differently in
-- three places.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_asset_cluster(asset_key TEXT)
RETURNS TEXT
IMMUTABLE
LANGUAGE sql AS $$
  SELECT CASE
    WHEN asset_key LIKE 'localnet:%'     THEN 'localnet'
    WHEN asset_key LIKE 'devnet:%'       THEN 'devnet'
    WHEN asset_key LIKE 'testnet:%'      THEN 'testnet'
    WHEN asset_key LIKE 'mainnet-beta:%' THEN 'mainnet-beta'
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION ledger_asset_cluster(TEXT) IS
  'The cluster prefix of a ledger asset key, or NULL when it has none (ADR-0021).';

-- ---------------------------------------------------------------------------
-- 2. Backfill.
--
-- `ledger_entries` is append-only and its triggers refuse UPDATE from
-- EVERYONE, including this migration — deliberately, so nobody can quietly
-- correct a balance. Qualifying a namespace is not correcting a balance: no
-- amount, direction, account or transaction membership changes, and step 3
-- proves it. The triggers are disabled for exactly these statements and
-- restored immediately.
-- ---------------------------------------------------------------------------

-- The pre-image, for the verification below.
CREATE TEMP TABLE cluster_backfill_before ON COMMIT DROP AS
  SELECT asset, direction, SUM(amount) AS total, COUNT(*) AS rows
  FROM "ledger_entries"
  GROUP BY asset, direction;

ALTER TABLE "ledger_entries" DISABLE TRIGGER "ledger_entries_no_update";

UPDATE "ledger_entries"
   SET asset = current_setting('wallet.resolved_backfill_cluster') || ':' || asset
 WHERE ledger_asset_cluster(asset) IS NULL;

ALTER TABLE "ledger_entries" ENABLE TRIGGER "ledger_entries_no_update";

UPDATE "ledger_accounts"
   SET asset = current_setting('wallet.resolved_backfill_cluster') || ':' || asset
 WHERE ledger_asset_cluster(asset) IS NULL;

-- Deposits and withdrawals carry the asset key they post to the ledger. Kept
-- identical on purpose: a translation layer between the two is somewhere a
-- mistake can live unnoticed.
UPDATE "deposits"
   SET asset = current_setting('wallet.resolved_backfill_cluster') || ':' || asset
 WHERE ledger_asset_cluster(asset) IS NULL;

UPDATE "withdrawals"
   SET asset = current_setting('wallet.resolved_backfill_cluster') || ':' || asset
 WHERE ledger_asset_cluster(asset) IS NULL;

-- The `chain` column becomes cluster-qualified too: `solana:devnet`. These
-- tables already had the column, so per-cluster isolation of addresses,
-- nonce pools and indexer cursors needs no schema change at all — only a value
-- that says WHICH cluster.
UPDATE "wallets"          SET chain = 'solana:' || current_setting('wallet.resolved_backfill_cluster') WHERE chain = 'solana';
UPDATE "addresses"        SET chain = 'solana:' || current_setting('wallet.resolved_backfill_cluster') WHERE chain = 'solana';
UPDATE "deposits"         SET chain = 'solana:' || current_setting('wallet.resolved_backfill_cluster') WHERE chain = 'solana';
UPDATE "withdrawals"      SET chain = 'solana:' || current_setting('wallet.resolved_backfill_cluster') WHERE chain = 'solana';
UPDATE "indexer_cursors"  SET chain = 'solana:' || current_setting('wallet.resolved_backfill_cluster') WHERE chain = 'solana';
UPDATE "nonce_accounts"   SET chain = 'solana:' || current_setting('wallet.resolved_backfill_cluster') WHERE chain = 'solana';

-- ---------------------------------------------------------------------------
-- 3. Prove the backfill moved no money.
--
-- Every amount, direction and row count must survive the rename exactly. This
-- is the check that makes disabling an append-only trigger defensible: it is
-- not "we were careful", it is "the totals are identical or the migration
-- aborts".
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  drift RECORD;
BEGIN
  FOR drift IN
    SELECT COALESCE(b.asset, 'MISSING') AS asset,
           COALESCE(b.direction::text, '?') AS direction,
           b.total AS before_total, b.rows AS before_rows,
           a.total AS after_total,  a.rows AS after_rows
    FROM cluster_backfill_before b
    FULL OUTER JOIN (
      SELECT split_part(asset, ':', 1) AS cluster,
             substring(asset from position(':' in asset) + 1) AS asset,
             direction, SUM(amount) AS total, COUNT(*) AS rows
      FROM "ledger_entries"
      GROUP BY 1, 2, 3
    ) a ON a.asset = b.asset AND a.direction = b.direction
    WHERE a.total IS DISTINCT FROM b.total OR a.rows IS DISTINCT FROM b.rows
  LOOP
    RAISE EXCEPTION
      'cluster backfill changed the books for %/%: % rows totalling % became % rows totalling %',
      drift.asset, drift.direction,
      drift.before_rows, drift.before_total, drift.after_rows, drift.after_total
      USING ERRCODE = 'check_violation';
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. An unqualified asset key is refused from here on.
--
-- The application refuses one too (`buildTransaction`), which produces the
-- comprehensible error. This is the guarantee: it holds for raw SQL, for a
-- migration, and for any future code path that forgets the builder.
-- ---------------------------------------------------------------------------
ALTER TABLE "ledger_accounts" DROP CONSTRAINT IF EXISTS ledger_accounts_asset_has_cluster;
ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT ledger_accounts_asset_has_cluster
  CHECK (ledger_asset_cluster(asset) IS NOT NULL);

ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS ledger_entries_asset_has_cluster;
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT ledger_entries_asset_has_cluster
  CHECK (ledger_asset_cluster(asset) IS NOT NULL);

ALTER TABLE "deposits" DROP CONSTRAINT IF EXISTS deposits_asset_has_cluster;
ALTER TABLE "deposits"
  ADD CONSTRAINT deposits_asset_has_cluster
  CHECK (ledger_asset_cluster(asset) IS NOT NULL);

ALTER TABLE "withdrawals" DROP CONSTRAINT IF EXISTS withdrawals_asset_has_cluster;
ALTER TABLE "withdrawals"
  ADD CONSTRAINT withdrawals_asset_has_cluster
  CHECK (ledger_asset_cluster(asset) IS NOT NULL);

-- The chain id says which cluster, everywhere it appears. Without this a row
-- written as plain `solana` would be invisible to every cluster-scoped query
-- and would look like a deposit that never happened.
ALTER TABLE "wallets"         DROP CONSTRAINT IF EXISTS wallets_chain_has_cluster;
ALTER TABLE "wallets"         ADD CONSTRAINT wallets_chain_has_cluster         CHECK (chain LIKE '%:%');
ALTER TABLE "addresses"       DROP CONSTRAINT IF EXISTS addresses_chain_has_cluster;
ALTER TABLE "addresses"       ADD CONSTRAINT addresses_chain_has_cluster       CHECK (chain LIKE '%:%');
ALTER TABLE "deposits"        DROP CONSTRAINT IF EXISTS deposits_chain_has_cluster;
ALTER TABLE "deposits"        ADD CONSTRAINT deposits_chain_has_cluster        CHECK (chain LIKE '%:%');
ALTER TABLE "withdrawals"     DROP CONSTRAINT IF EXISTS withdrawals_chain_has_cluster;
ALTER TABLE "withdrawals"     ADD CONSTRAINT withdrawals_chain_has_cluster     CHECK (chain LIKE '%:%');
ALTER TABLE "indexer_cursors" DROP CONSTRAINT IF EXISTS indexer_cursors_chain_has_cluster;
ALTER TABLE "indexer_cursors" ADD CONSTRAINT indexer_cursors_chain_has_cluster CHECK (chain LIKE '%:%');
ALTER TABLE "nonce_accounts"  DROP CONSTRAINT IF EXISTS nonce_accounts_chain_has_cluster;
ALTER TABLE "nonce_accounts"  ADD CONSTRAINT nonce_accounts_chain_has_cluster  CHECK (chain LIKE '%:%');

-- ---------------------------------------------------------------------------
-- 5. A ledger transaction belongs to exactly ONE cluster.
--
-- The per-asset balance check already makes a cross-cluster TRANSFER
-- impossible: debit `devnet:SOL` and credit `mainnet-beta:SOL` leaves two
-- groups, each with a residual. What it does not catch is a transaction that
-- is balanced in two clusters at once — nothing crosses, nothing is
-- unbalanced, and yet one financial event claims to have happened on two
-- chains. Settling it would be undoable on one of them.
--
-- DEFERRED for the same reason as the balance check: entries are inserted one
-- at a time, so every intermediate state is legitimately incomplete.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_transaction_single_cluster()
RETURNS TRIGGER AS $$
DECLARE
  clusters TEXT[];
BEGIN
  SELECT ARRAY_AGG(DISTINCT ledger_asset_cluster(asset))
    INTO clusters
    FROM "ledger_entries"
   WHERE transaction_id = NEW.transaction_id;

  IF array_length(clusters, 1) > 1 THEN
    RAISE EXCEPTION
      'ledger transaction % spans clusters %: devnet money and mainnet money are different money (ADR-0021)',
      NEW.transaction_id, clusters
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_single_cluster ON "ledger_entries";
CREATE CONSTRAINT TRIGGER ledger_entries_single_cluster
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_transaction_single_cluster();
