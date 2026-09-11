import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

export interface CursorRepository {
  get(addressId: string, tx?: Executor): Promise<string | null>;
  /**
   * Persist the cursor for an address.
   *
   * MUST be called only after the batch it describes has fully committed
   * (prompt_phase2.md rules 146-147). Persisting first and processing after
   * means a crash in between loses every transfer in that batch — permanently,
   * because the cursor has already moved past them. The other way round costs a
   * re-read, and a re-read is a no-op by the deposit uniqueness constraint.
   */
  advance(
    input: { addressId: string; chain: string; signature: string; position: bigint | null },
    tx?: Executor,
  ): Promise<void>;
  touch(addressId: string, chain: string, tx?: Executor): Promise<void>;
}

export function createCursorRepository(db: Executor): CursorRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async get(addressId, tx) {
      const row = await exec(tx).indexerCursor.findUnique({
        where: { addressId },
        select: { lastSignature: true },
      });
      return row?.lastSignature ?? null;
    },

    async advance(input, tx) {
      await exec(tx).indexerCursor.upsert({
        where: { addressId: input.addressId },
        create: {
          id: newId(),
          addressId: input.addressId,
          chain: input.chain,
          lastSignature: input.signature,
          lastPosition: input.position,
          lastPolledAt: new Date(),
        },
        update: {
          lastSignature: input.signature,
          lastPosition: input.position,
          lastPolledAt: new Date(),
        },
      });
    },

    /** Records that a poll happened even though it found nothing. */
    async touch(addressId, chain, tx) {
      await exec(tx).indexerCursor.upsert({
        where: { addressId },
        create: { id: newId(), addressId, chain, lastPolledAt: new Date() },
        update: { lastPolledAt: new Date() },
      });
    },
  };
}
