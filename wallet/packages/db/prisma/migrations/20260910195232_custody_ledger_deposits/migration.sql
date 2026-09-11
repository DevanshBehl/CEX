-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('active', 'frozen', 'closed');

-- CreateEnum
CREATE TYPE "CustodyRole" AS ENUM ('deposit', 'hot', 'warm', 'cold');

-- CreateEnum
CREATE TYPE "AddressStatus" AS ENUM ('active', 'retired');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('user_available', 'user_locked', 'chain_assets', 'house_fees', 'house_rent', 'external');

-- CreateEnum
CREATE TYPE "LedgerTransactionKind" AS ENUM ('deposit', 'withdrawal_lock', 'withdrawal_release', 'withdrawal_settle', 'sweep', 'fee', 'adjustment');

-- CreateEnum
CREATE TYPE "EntryDirection" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('confirming', 'credited', 'ignored');

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "status" "WalletStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "derivation_index" INTEGER NOT NULL,
    "derivation_path" TEXT NOT NULL,
    "custody_role" "CustodyRole" NOT NULL DEFAULT 'deposit',
    "status" "AddressStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "owner_id" UUID,
    "asset" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "kind" "LedgerTransactionKind" NOT NULL,
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "rent_reserved" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "tx_signature" TEXT NOT NULL,
    "instruction_index" INTEGER NOT NULL,
    "position" BIGINT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'confirming',
    "reason" TEXT,
    "ledger_transaction_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "credited_at" TIMESTAMPTZ(3),

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_cursors" (
    "id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "address_id" UUID NOT NULL,
    "last_signature" TEXT,
    "last_position" BIGINT,
    "last_polled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "indexer_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallets_user_id_idx" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_chain_key" ON "wallets"("user_id", "chain");

-- CreateIndex
CREATE INDEX "addresses_wallet_id_status_idx" ON "addresses"("wallet_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "addresses_chain_address_key" ON "addresses"("chain", "address");

-- CreateIndex
CREATE UNIQUE INDEX "addresses_chain_derivation_index_key" ON "addresses"("chain", "derivation_index");

-- CreateIndex
CREATE INDEX "ledger_accounts_asset_type_idx" ON "ledger_accounts"("asset", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_owner_id_asset_type_key" ON "ledger_accounts"("owner_id", "asset", "type");

-- CreateIndex
CREATE INDEX "ledger_transactions_reference_type_reference_id_idx" ON "ledger_transactions"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_kind_created_at_idx" ON "ledger_transactions"("kind", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_asset_idx" ON "ledger_entries"("account_id", "asset");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_ledger_transaction_id_key" ON "deposits"("ledger_transaction_id");

-- CreateIndex
CREATE INDEX "deposits_user_id_created_at_idx" ON "deposits"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "deposits_status_created_at_idx" ON "deposits"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_chain_tx_signature_instruction_index_key" ON "deposits"("chain", "tx_signature", "instruction_index");

-- CreateIndex
CREATE UNIQUE INDEX "indexer_cursors_address_id_key" ON "indexer_cursors"("address_id");

-- CreateIndex
CREATE INDEX "indexer_cursors_chain_last_polled_at_idx" ON "indexer_cursors"("chain", "last_polled_at");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_ledger_transaction_id_fkey" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indexer_cursors" ADD CONSTRAINT "indexer_cursors_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
