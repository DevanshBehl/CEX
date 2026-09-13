import type { AddressDeriver, AddressValidator, KeyProvisioner } from '@wallet/blockchain';
import {
  createCustodyRepository,
  createLedgerRepository,
  withTransaction,
  type AddressRecord,
  type PrismaClient,
} from '@wallet/db';
import { NotFoundError, AuthorizationDeniedError } from '@wallet/errors';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import { clusterFromChainId } from '@wallet/types';

export interface CustodyServiceDeps {
  readonly db: PrismaClient;
  /**
   * Seed derivation. The LEGACY path (ADR-0004), kept for deployments with no
   * coordinator — local development against the mock signer, and every address
   * issued before ADR-0020.
   */
  readonly deriver: AddressDeriver;
  /**
   * Per-user threshold keys (ADR-0020).
   *
   * When present, an address is a provisioned FROST group's verifying key and
   * no seed is involved. When absent the deriver is used and the deployment is
   * NOT segregated — a distinction worth being able to see, which is why this
   * is an explicit dependency rather than a flag read from the environment.
   */
  readonly keys?: KeyProvisioner | undefined;
  readonly validator: AddressValidator;
  /** Cluster-qualified: `solana:devnet` (ADR-0021). */
  readonly chain: string;
  /** This cluster's asset keys, already cluster-qualified. */
  readonly assets: readonly string[];
  readonly logger: Logger;
}

export interface CustodyService {
  ensureWallet(userId: string): Promise<{ id: string; chain: string }>;
  getOrCreateDepositAddress(userId: string): Promise<AddressRecord>;
  listAddresses(userId: string, walletId: string): Promise<AddressRecord[]>;
  getBalances(
    userId: string,
  ): Promise<Array<{ asset: string; available: string; locked: string; total: string }>>;
}

/**
 * The key reference for a user's segregated key.
 *
 * One function, because the API and the signing worker must agree exactly:
 * two spellings of this string would mean a withdrawal asking the coordinator
 * to sign with a key that was never provisioned.
 */
export function userKeyRef(userId: string): string {
  return `user:${userId}`;
}

export function createCustodyService(deps: CustodyServiceDeps): CustodyService {
  const custody = createCustodyRepository(deps.db);
  const ledger = createLedgerRepository(deps.db);

  function deriveFromSeed(index: number): { address: string; derivationPath: string } {
    const derived = deps.deriver.derive(index);
    return { address: derived.address, derivationPath: derived.derivationPath };
  }

  /**
   * Ask the coordinator for this user's own 3-of-5 group.
   *
   * The coordinator runs distributed key generation (ADR-0023): the five
   * participants each contribute a secret nobody else sees, and what comes
   * back is public — the group key, which is the address, and the
   * participants' verification shares. No process ever held the private key.
   *
   * Only a FINALIZED result reaches this function: the client throws on
   * anything less, so the transaction below that writes the address row never
   * runs for a ceremony that did not complete on every participant.
   *
   * The call is idempotent on `keyRef` — the coordinator serialises ceremonies
   * per key reference and returns an existing key without running a round —
   * which is what makes it safe inside a request that may be retried: a second
   * attempt returns the address the first one created rather than minting a
   * second key and stranding the first. That property lives in the service,
   * not here — a client-side guard would not survive a crash between the call
   * and the commit.
   */
  async function provisionSegregatedAddress(
    keys: KeyProvisioner,
    userId: string,
  ): Promise<{ address: string; derivationPath: string }> {
    const keyRef = userKeyRef(userId);
    const provisioned = await keys.provisionKey({ id: keyRef });

    return {
      address: provisioned.address,
      // Not a BIP-32 path: there is no seed and no index (ADR-0020). It records
      // what the address IS, so a row is never mistaken for a derived one.
      derivationPath: `frost:${provisioned.threshold}-of-${provisioned.participants}:${keyRef}`,
    };
  }

  return {
    async ensureWallet(userId) {
      const wallet = await custody.ensureWallet(userId, deps.chain);
      return { id: wallet.id, chain: wallet.chain };
    },

    /**
     * Assignment is idempotent (prompt_phase2.md rules 142-143).
     *
     * A user who asks twice gets the same address. Deriving a fresh one per
     * request would grow the indexer's watch set without bound, and the user
     * would keep using the first one anyway — so the old address must stay
     * watched forever regardless, and nothing is gained.
     */
    async getOrCreateDepositAddress(userId) {
      const wallet = await custody.ensureWallet(userId, deps.chain);

      const existing = await custody.findActiveDepositAddress(wallet.id);
      if (existing) return existing;

      /*
       * Provisioned OUTSIDE the transaction, deliberately.
       *
       * It is a multi-round ceremony across five participants that can take
       * seconds, and the index claim
       * below takes an advisory lock — holding that lock across a threshold
       * ceremony would serialise every signup in the system behind the slowest
       * participant.
       *
       * Safe to do first because it is idempotent on the key reference: a
       * crash between here and the commit leaves a provisioned key with no
       * address row, and the next attempt returns that same key rather than
       * minting a second one.
       */
      const provisioned = deps.keys ? await provisionSegregatedAddress(deps.keys, userId) : null;

      // The index claim and the address insert are one transaction. The claim
      // takes an advisory lock, so two concurrent first-requests cannot derive
      // the same index — which would give two users the same address and
      // misattribute every deposit to whichever row was written first.
      return withTransaction(deps.db, async (tx) => {
        const again = await custody.findActiveDepositAddress(wallet.id, tx);
        if (again) return again;

        /*
         * The index is still claimed under segregation, and is still unique per
         * chain — but it no longer DERIVES anything. It survives as an ordinal
         * because the column is `NOT NULL` and unique, and because it is the
         * only stable ordering of address issuance the schema has. The
         * derivation path records which mechanism produced the address, so a
         * row can always be read for what it is.
         */
        const index = await custody.claimNextDerivationIndex(deps.chain, tx);

        const { address, derivationPath } = provisioned ?? deriveFromSeed(index);

        // Neither mechanism should produce an invalid address; if one does,
        // that is a bug and the user must not be handed the result.
        const verdict = deps.validator.isWellFormed(address);
        if (!verdict.ok) {
          throw new Error(`produced an invalid address at index ${index}: ${verdict.reason}`);
        }

        const created = await custody.createAddress(
          {
            walletId: wallet.id,
            chain: deps.chain,
            address,
            derivationIndex: index,
            derivationPath,
            custodyRole: 'deposit',
          },
          tx,
        );

        // The address is watched by virtue of existing: listWatched selects
        // active deposit addresses, so creation and registration are the same
        // write and cannot diverge (rule 144).
        logSecurityEvent(deps.logger, 'address.assigned', {
          outcome: 'success',
          userId,
          targetType: 'address',
          targetId: created.id,
        });

        return created;
      });
    },

    async listAddresses(userId, walletId) {
      const wallet = await custody.findWalletById(walletId);
      if (!wallet) throw new NotFoundError('Wallet not found');
      // Another user's wallet id is reported as forbidden only after we know it
      // exists; a caller cannot distinguish the two, because both paths end in
      // an error with no detail (rule 168).
      if (wallet.userId !== userId) throw new AuthorizationDeniedError('Wallet not found');
      return custody.listAddresses(walletId);
    },

    /**
     * Balances, projected from ledger entries (rules 82-85).
     *
     * Assets the user has never held are returned as zero rather than omitted,
     * so the client renders a stable list instead of one that changes shape on
     * the first deposit.
     */
    async getBalances(userId) {
      // Scoped to this service's cluster. Without the filter a user on two
      // clusters sees one merged list, and devnet play money is added to real
      // money with nothing reporting an error (ADR-0021).
      const held = await ledger.getUserBalances(userId, clusterFromChainId(deps.chain));
      const byAsset = new Map(held.map((row) => [row.asset, row]));

      return deps.assets.map(
        (asset) => byAsset.get(asset) ?? { asset, available: '0', locked: '0', total: '0' },
      );
    },
  };
}
