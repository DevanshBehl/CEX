-- CreateEnum
CREATE TYPE "OperatorRoleName" AS ENUM ('viewer', 'approver', 'custodian');

-- CreateTable
CREATE TABLE "operator_roles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OperatorRoleName" NOT NULL,
    "granted_by_user_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "reason" TEXT,

    CONSTRAINT "operator_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operator_roles_role_revoked_at_idx" ON "operator_roles"("role", "revoked_at");

-- ONE LIVE GRANT PER (user, role) — as a PARTIAL index.
--
-- Prisma generated UNIQUE (user_id, role, revoked_at) from the @@unique. In
-- PostgreSQL two NULLs are distinct, so that index permits unlimited rows with
-- revoked_at IS NULL — exactly the case it was meant to prevent, and the
-- failure would be silent: a user accumulating duplicate live grants that
-- revocation then only half-removes.
--
-- The partial index says what was actually meant.
CREATE UNIQUE INDEX "operator_roles_one_live_grant"
    ON "operator_roles" ("user_id", "role")
    WHERE "revoked_at" IS NULL;

-- AddForeignKey
ALTER TABLE "operator_roles" ADD CONSTRAINT "operator_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_roles" ADD CONSTRAINT "operator_roles_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Grants (ADR-0003)
-- ---------------------------------------------------------------------------
--
-- Roles are cluster-scoped but GRANTS are not, so they live in a migration —
-- otherwise a `migrate reset` silently drops them and the application starts
-- failing with "relation does not exist" as the app user.
GRANT SELECT, INSERT, UPDATE ON TABLE "operator_roles" TO wallet_app;

-- APPEND-MOSTLY, not append-only.
--
-- A grant must be revocable, so UPDATE is permitted — but only to set
-- `revoked_at`. Rewriting who granted what, or when, would make the audit
-- trail a record of the present rather than of what happened
-- (master-prompt rule 166).
--
-- DELETE is refused outright: "who could approve withdrawals in March" has to
-- stay answerable.
REVOKE DELETE, TRUNCATE ON TABLE "operator_roles" FROM wallet_app;

CREATE OR REPLACE FUNCTION operator_roles_append_mostly() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'operator_roles is append-mostly: DELETE is not permitted. Revoke the grant instead (prompt_phase4.md rule 166).'
            USING ERRCODE = '23001';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
        OR NEW."role" IS DISTINCT FROM OLD."role"
        OR NEW."granted_by_user_id" IS DISTINCT FROM OLD."granted_by_user_id"
        OR NEW."granted_at" IS DISTINCT FROM OLD."granted_at"
    THEN
        RAISE EXCEPTION 'operator_roles: only revoked_at and reason may be updated (master-prompt rule 166).'
            USING ERRCODE = '23001';
    END IF;

    -- A revocation is final. Un-revoking would let an operator's authority
    -- reappear with its original grant timestamp, which reads as though it was
    -- never withdrawn.
    IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
        RAISE EXCEPTION 'operator_roles: a revoked grant cannot be un-revoked. Grant a new role instead.'
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER operator_roles_no_delete
    BEFORE DELETE ON "operator_roles"
    FOR EACH ROW EXECUTE FUNCTION operator_roles_append_mostly();

CREATE TRIGGER operator_roles_restricted_update
    BEFORE UPDATE ON "operator_roles"
    FOR EACH ROW EXECUTE FUNCTION operator_roles_append_mostly();
