import { createLedgerRepository, type Executor } from '@wallet/db';
import { toBaseUnits, type LedgerTransaction } from '@wallet/ledger';

/**
 * Persist a posting built by `packages/ledger`. The posting functions are the
 * ONLY place entries are assembled; this only changes their representation.
 */
export async function postLedger(
  tx: Executor,
  posting: LedgerTransaction,
  id?: string,
): Promise<string> {
  return createLedgerRepository(tx).postTransaction(
    {
      ...(id === undefined ? {} : { id }),
      kind: posting.kind,
      referenceType: posting.referenceType,
      referenceId: posting.referenceId,
      entries: posting.entries.map((entry) => ({
        account: {
          ownerId: entry.account.ownerId,
          asset: entry.account.asset,
          type: entry.account.type,
        },
        asset: entry.asset,
        amount: toBaseUnits(entry.amount),
        direction: entry.direction,
      })),
    },
    tx,
  );
}
