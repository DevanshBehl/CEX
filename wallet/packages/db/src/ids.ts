import { v7 as uuidv7 } from 'uuid';

/**
 * UUIDv7 for every primary key (prompt_phase1.md rule 93).
 *
 * Two reasons over a serial:
 *   - It is time-ordered, so inserts land at the right end of the B-tree
 *     instead of scattering the way UUIDv4 does.
 *   - It does not leak a row count. `/users/42` tells an observer how many
 *     users exist; a UUID tells them nothing.
 *
 * Generated in application code rather than by the database so that a command
 * knows the id of the row it is about to write before the transaction commits —
 * which is what lets an audit row and the row it describes be written together
 * (and, in Phase 2, a ledger transaction and its entries).
 */
export function newId(): string {
  return uuidv7();
}
