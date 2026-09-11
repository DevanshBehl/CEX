import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

export interface NonceAccountRecord {
  id: string;
  chain: string;
  address: string;
  status: 'available' | 'leased' | 'retired';
  currentNonce: string | null;
  leasedBy: string | null;
  leasedAt: Date | null;
}

export interface NonceAccountRepository {
  create(
    input: { chain: string; address: string; currentNonce?: string },
    tx?: Executor,
  ): Promise<NonceAccountRecord>;
  /**
   * Take one available account for a withdrawal, or null if the pool is dry.
   *
   * `FOR UPDATE SKIP LOCKED` plus the partial unique index on `leased_by` means
   * two withdrawals can never hold the same account (prompt_phase3.md rule 38).
   * Two transactions on one nonce produce two transactions where only one can
   * win, and the loser's failure is indistinguishable from an expiry.
   */
  lease(chain: string, withdrawalId: string, tx?: Executor): Promise<NonceAccountRecord | null>;
  release(withdrawalId: string, tx?: Executor): Promise<void>;
  recordNonce(id: string, nonce: string, tx?: Executor): Promise<void>;
  findById(id: string, tx?: Executor): Promise<NonceAccountRecord | null>;
  countAvailable(chain: string, tx?: Executor): Promise<number>;
  listAll(chain: string, tx?: Executor): Promise<NonceAccountRecord[]>;
}

export function createNonceAccountRepository(db: Executor): NonceAccountRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async create(input, tx) {
      const row = await exec(tx).nonceAccount.create({
        data: {
          id: newId(),
          chain: input.chain,
          address: input.address,
          ...(input.currentNonce !== undefined ? { currentNonce: input.currentNonce } : {}),
        },
      });
      return toRecord(row);
    },

    async lease(chain, withdrawalId, tx) {
      const e = exec(tx);

      // Already holds one? Leasing again would strand the first.
      const held = await e.nonceAccount.findFirst({ where: { leasedBy: withdrawalId } });
      if (held) return toRecord(held);

      const rows = await e.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM nonce_accounts
        WHERE chain = ${chain} AND status = 'available'
        ORDER BY updated_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;

      const id = rows[0]?.id;
      // A dry pool is a real operational condition, not an error: the caller
      // leaves the withdrawal where it is and retries on the next cycle.
      if (id === undefined) return null;

      const updated = await e.nonceAccount.updateMany({
        where: { id, status: 'available' },
        data: { status: 'leased', leasedBy: withdrawalId, leasedAt: new Date() },
      });
      if (updated.count === 0) return null;

      const leased = await e.nonceAccount.findUniqueOrThrow({ where: { id } });
      return toRecord(leased);
    },

    async release(withdrawalId, tx) {
      await exec(tx).nonceAccount.updateMany({
        where: { leasedBy: withdrawalId },
        data: { status: 'available', leasedBy: null, leasedAt: null },
      });
    },

    async recordNonce(id, nonce, tx) {
      await exec(tx).nonceAccount.update({ where: { id }, data: { currentNonce: nonce } });
    },

    async findById(id, tx) {
      const row = await exec(tx).nonceAccount.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async countAvailable(chain, tx) {
      return exec(tx).nonceAccount.count({ where: { chain, status: 'available' } });
    },

    async listAll(chain, tx) {
      const rows = await exec(tx).nonceAccount.findMany({ where: { chain } });
      return rows.map(toRecord);
    },
  };
}

function toRecord(row: {
  id: string;
  chain: string;
  address: string;
  status: string;
  currentNonce: string | null;
  leasedBy: string | null;
  leasedAt: Date | null;
}): NonceAccountRecord {
  return { ...row, status: row.status as NonceAccountRecord['status'] };
}
