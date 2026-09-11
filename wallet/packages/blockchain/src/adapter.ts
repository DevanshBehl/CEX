import type { AddressValidator } from './address.js';
import type {
  Address,
  ChainId,
  ChainPosition,
  Confirmation,
  FetchTransfersRequest,
  TransferPage,
  TxReference,
} from './chain.js';

/**
 * What the domain needs from a chain (prompt_phase2.md rule 92).
 *
 * Split into two interfaces on purpose. Phase 2 needs only `TransferSource` and
 * the read side; the send side is Phase 3. Keeping them apart means Phase 2 can
 * implement, test, and depend on exactly what it uses, instead of an interface
 * that is mostly `throw new Error('not implemented')`.
 */

/** Where incoming transfers come from (ADR-0007). */
export interface TransferSource {
  readonly chain: ChainId;
  /**
   * A page of transfers to one address, oldest first.
   *
   * Ordering matters: the cursor advances through history, and an
   * out-of-order page makes "everything before this cursor is committed"
   * false, which is the assumption restart-safety rests on.
   */
  fetchTransfers(request: FetchTransfersRequest): Promise<TransferPage>;
}

export interface ChainReader {
  readonly chain: ChainId;
  readonly validator: AddressValidator;
  getBalance(address: Address, asset: string): Promise<string>;
  getConfirmation(reference: TxReference): Promise<Confirmation>;
  getPosition(): Promise<ChainPosition>;
  /**
   * The minimum balance an account needs in order to exist.
   *
   * Read from the chain, never hardcoded (prompt_phase2.md rule 114): it is a
   * network parameter, and a stale constant here would misattribute the
   * difference between a user's balance and a house account.
   */
  getMinimumAccountBalance(asset: string): Promise<string>;
  /**
   * Does this account exist on chain?
   *
   * Needed because some chains require an account to be created before it can
   * receive a given asset, and creating one that already exists fails the
   * transaction as surely as not creating one that is missing. The caller must
   * ASK rather than assume — and that is a question about the chain, not about
   * the asset, so it belongs on the reader.
   */
  accountExists(address: Address): Promise<boolean>;
  /**
   * An opaque identifier for the network this endpoint actually serves.
   *
   * Every chain has one — a genesis hash, a chain id — and the domain never
   * interprets it. It exists so a deployment can VERIFY that the endpoint it
   * is talking to is the network it believes it is talking to.
   *
   * That check matters because the network name is shown to users as the
   * network to send funds on. A configuration that names one network and
   * points at another tells people to send real money to an address nothing is
   * watching.
   */
  getNetworkIdentity(): Promise<string>;
  isHealthy(): Promise<boolean>;
}

/**
 * The full adapter. Phase 2 implements the read half; the send half arrives
 * with Phase 3's withdrawal lifecycle.
 */
export interface ChainAdapter extends ChainReader, TransferSource {}
