import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

/**
 * Operator roles (prompt_phase4.md rule 166).
 *
 * Phase 3 used `OPERATOR_USER_IDS`, an environment variable. That made
 * operator authority a deploy-time property: granting required a restart,
 * revoking required a restart, and nothing recorded who granted it or why.
 * All three are worst during an incident, which is exactly when operator
 * authority is used.
 */

export const OPERATOR_ROLES = ['viewer', 'approver', 'custodian'] as const;
export type OperatorRoleName = (typeof OPERATOR_ROLES)[number];

export interface OperatorRoleRecord {
  id: string;
  userId: string;
  role: OperatorRoleName;
  grantedByUserId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  reason: string | null;
}

export interface OperatorRepository {
  /** Live roles for a user, in a single query. */
  rolesFor(userId: string, tx?: Executor): Promise<OperatorRoleName[]>;
  grant(
    input: {
      userId: string;
      role: OperatorRoleName;
      grantedByUserId: string | null;
      reason?: string | undefined;
    },
    tx?: Executor,
  ): Promise<OperatorRoleRecord>;
  revoke(userId: string, role: OperatorRoleName, tx?: Executor): Promise<boolean>;
  /** Every grant a user has ever held, including revoked ones. */
  history(userId: string, tx?: Executor): Promise<OperatorRoleRecord[]>;
  /** Everyone currently holding a given role. */
  holders(role: OperatorRoleName, tx?: Executor): Promise<OperatorRoleRecord[]>;
}

export function createOperatorRepository(db: Executor): OperatorRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async rolesFor(userId, tx) {
      const rows = await exec(tx).operatorRole.findMany({
        where: { userId, revokedAt: null },
        select: { role: true },
      });
      return rows.map((row) => row.role as OperatorRoleName);
    },

    async grant(input, tx) {
      /*
       * No upsert, and no "already granted" short-circuit.
       *
       * The partial unique index permits exactly one LIVE grant per
       * (user, role), so a duplicate raises — and that is the right outcome:
       * a second grant of a role someone already holds means the caller's
       * understanding of the current state is wrong, and silently succeeding
       * would hide that.
       */
      const row = await exec(tx).operatorRole.create({
        data: {
          id: newId(),
          userId: input.userId,
          role: input.role,
          grantedByUserId: input.grantedByUserId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
      });
      return toRecord(row);
    },

    async revoke(userId, role, tx) {
      // Scoped to the live grant. A revoked row cannot be touched again — the
      // database refuses an un-revoke — so this is naturally idempotent in
      // effect: a second revocation matches nothing.
      const result = await exec(tx).operatorRole.updateMany({
        where: { userId, role, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count > 0;
    },

    async history(userId, tx) {
      const rows = await exec(tx).operatorRole.findMany({
        where: { userId },
        orderBy: { grantedAt: 'desc' },
      });
      return rows.map(toRecord);
    },

    async holders(role, tx) {
      const rows = await exec(tx).operatorRole.findMany({
        where: { role, revokedAt: null },
        orderBy: { grantedAt: 'asc' },
      });
      return rows.map(toRecord);
    },
  };
}

function toRecord(row: {
  id: string;
  userId: string;
  role: string;
  grantedByUserId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  reason: string | null;
}): OperatorRoleRecord {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role as OperatorRoleName,
    grantedByUserId: row.grantedByUserId,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    reason: row.reason,
  };
}
