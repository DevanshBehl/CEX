import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

export interface RecoveryCodeRepository {
  replaceAllForUser(userId: string, codeHashes: Uint8Array[], tx?: Executor): Promise<void>;
  /** Atomically marks one unused code as used. Returns false if it was already
   *  spent or never existed — single-use is enforced by the update's WHERE
   *  clause, not by a read-then-write (rule 133). */
  consume(userId: string, codeHash: Uint8Array, tx?: Executor): Promise<boolean>;
  countUnused(userId: string, tx?: Executor): Promise<number>;
  deleteAllForUser(userId: string, tx?: Executor): Promise<void>;
}

export function createRecoveryCodeRepository(db: Executor): RecoveryCodeRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async replaceAllForUser(userId, codeHashes, tx) {
      const e = exec(tx);
      await e.recoveryCode.deleteMany({ where: { userId } });
      await e.recoveryCode.createMany({
        data: codeHashes.map((codeHash) => ({
          id: newId(),
          userId,
          codeHash: Buffer.from(codeHash),
        })),
      });
    },

    async consume(userId, codeHash, tx) {
      const result = await exec(tx).recoveryCode.updateMany({
        where: { userId, codeHash: Buffer.from(codeHash), usedAt: null },
        data: { usedAt: new Date() },
      });
      return result.count === 1;
    },

    async countUnused(userId, tx) {
      return exec(tx).recoveryCode.count({ where: { userId, usedAt: null } });
    },

    async deleteAllForUser(userId, tx) {
      await exec(tx).recoveryCode.deleteMany({ where: { userId } });
    },
  };
}
