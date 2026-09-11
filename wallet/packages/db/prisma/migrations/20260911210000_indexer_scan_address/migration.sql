-- Which on-chain account each cursor tracks (ADR-0016).
--
-- A native deposit is found by polling the deposit address. A TOKEN deposit is
-- not: a token transfer moves between token accounts and the owner's address is
-- not among the transaction's account keys, so polling the owner returns
-- nothing forever. Verified against a real validator — a mint to a deposit
-- address's token account produced 1 signature for the token account and 0 for
-- the owner.
--
-- So one address now has one cursor per scanned account.

ALTER TABLE "indexer_cursors" ADD COLUMN "scan_address" TEXT;

-- Backfill: every existing cursor was tracking the deposit address itself.
UPDATE "indexer_cursors" c
SET "scan_address" = a."address"
FROM "addresses" a
WHERE a."id" = c."address_id" AND c."scan_address" IS NULL;

ALTER TABLE "indexer_cursors" ALTER COLUMN "scan_address" SET NOT NULL;

-- One cursor per (address, scanned account). Replaces the old UNIQUE on
-- address_id alone, which allowed exactly one cursor per address and would
-- have made the token accounts collide with the native one.
DROP INDEX IF EXISTS "indexer_cursors_address_id_key";
CREATE UNIQUE INDEX "indexer_cursors_address_id_scan_address_key"
    ON "indexer_cursors" ("address_id", "scan_address");
