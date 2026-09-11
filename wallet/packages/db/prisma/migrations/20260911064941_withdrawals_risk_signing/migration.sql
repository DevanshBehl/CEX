-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'RISK_EVALUATING', 'MANUAL_REVIEW', 'APPROVED', 'FUNDS_LOCKED', 'SIGNING', 'SIGNED', 'BROADCAST', 'CONFIRMED', 'SETTLED', 'SIGN_FAILED', 'BROADCAST_FAILED', 'EXPIRED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "RiskVerdict" AS ENUM ('approve', 'deny', 'review');

-- CreateEnum
CREATE TYPE "SigningOutcome" AS ENUM ('requested', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "NonceAccountStatus" AS ENUM ('available', 'leased', 'retired');

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "network_fee" DECIMAL(38,0),
    "destination" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "idempotency_key" TEXT NOT NULL,
    "sign_attempts" INTEGER NOT NULL DEFAULT 0,
    "broadcast_attempts" INTEGER NOT NULL DEFAULT 0,
    "expiry_attempts" INTEGER NOT NULL DEFAULT 0,
    "lock_ledger_transaction_id" UUID,
    "settle_ledger_transaction_id" UUID,
    "signed_transaction" BYTEA,
    "tx_signature" TEXT,
    "nonce_account_id" UUID,
    "nonce_value" TEXT,
    "failure_reason" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "settled_at" TIMESTAMPTZ(3),

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_transitions" (
    "id" UUID NOT NULL,
    "withdrawal_id" UUID NOT NULL,
    "from_status" "WithdrawalStatus",
    "to_status" "WithdrawalStatus" NOT NULL,
    "reason" TEXT,
    "actor_user_id" UUID,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_decisions" (
    "id" UUID NOT NULL,
    "withdrawal_id" UUID NOT NULL,
    "verdict" "RiskVerdict" NOT NULL,
    "codes" TEXT[],
    "evaluated_rules" TEXT[],
    "input_snapshot" JSONB NOT NULL,
    "outcomes" JSONB NOT NULL,
    "policy_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signing_requests" (
    "id" UUID NOT NULL,
    "withdrawal_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "key_ref" TEXT NOT NULL,
    "outcome" "SigningOutcome" NOT NULL DEFAULT 'requested',
    "signer_kind" TEXT NOT NULL,
    "failure_reason" TEXT,
    "authorization" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "signing_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nonce_accounts" (
    "id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" "NonceAccountStatus" NOT NULL DEFAULT 'available',
    "current_nonce" TEXT,
    "leased_by" UUID,
    "leased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "nonce_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "withdrawals_status_created_at_idx" ON "withdrawals"("status", "created_at");

-- CreateIndex
CREATE INDEX "withdrawals_user_id_created_at_idx" ON "withdrawals"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "withdrawals_tx_signature_idx" ON "withdrawals"("tx_signature");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_user_id_idempotency_key_key" ON "withdrawals"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "withdrawal_transitions_withdrawal_id_created_at_idx" ON "withdrawal_transitions"("withdrawal_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "risk_decisions_withdrawal_id_key" ON "risk_decisions"("withdrawal_id");

-- CreateIndex
CREATE INDEX "risk_decisions_verdict_created_at_idx" ON "risk_decisions"("verdict", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "signing_requests_request_id_key" ON "signing_requests"("request_id");

-- CreateIndex
CREATE INDEX "signing_requests_withdrawal_id_created_at_idx" ON "signing_requests"("withdrawal_id", "created_at");

-- CreateIndex
CREATE INDEX "nonce_accounts_chain_status_idx" ON "nonce_accounts"("chain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "nonce_accounts_chain_address_key" ON "nonce_accounts"("chain", "address");

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_nonce_account_id_fkey" FOREIGN KEY ("nonce_account_id") REFERENCES "nonce_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_transitions" ADD CONSTRAINT "withdrawal_transitions_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signing_requests" ADD CONSTRAINT "signing_requests_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
