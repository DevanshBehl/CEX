import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

/**
 * A cursor is keyed on (address, SCANNED ACCOUNT), not on the address alone.
 *
 * A native deposit is found by polling the deposit address; a token deposit is
 * found by polling that address's token account, because a token transfer never
 * touches the owner's address (ADR-0016). One address therefore has several
 * cursors, and sharing one between them would let a native transfer advance
 * past token transfers that had not been seen.
 */
export interface CursorKey {
  readonly addressId: string;
  readonly scanAddress: string;
}

export interface CursorRepository {
  get(key: CursorKey, tx?: Executor): Promise<string | null>;
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
    input: CursorKey & { chain: string; signature: string; position: bigint | null },
    tx?: Executor,
  ): Promise<void>;
  touch(key: CursorKey, chain: string, tx?: Executor): Promise<void>;
}

export function createCursorRepository(db: Executor): CursorRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async get(key, tx) {
      const row = await exec(tx).indexerCursor.findUnique({
        where: { addressId_scanAddress: { ...key } },
        select: { lastSignature: true },
      });
      return row?.lastSignature ?? null;
    },

    async advance(input, tx) {
      await exec(tx).indexerCursor.upsert({
        where: {
          addressId_scanAddress: {
            addressId: input.addressId,
            scanAddress: input.scanAddress,
          },
        },
        create: {
          id: newId(),
          addressId: input.addressId,
          scanAddress: input.scanAddress,
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
    async touch(key, chain, tx) {
      await exec(tx).indexerCursor.upsert({
        where: { addressId_scanAddress: { ...key } },
        create: { id: newId(), ...key, chain, lastPolledAt: new Date() },
        update: { lastPolledAt: new Date() },
      });
    },
  };
}
