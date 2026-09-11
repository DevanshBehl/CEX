import type { AddressDeriver, AddressValidator } from '@wallet/blockchain';
import {
  createCustodyRepository,
  createLedgerRepository,
  withTransaction,
  type AddressRecord,
  type PrismaClient,
} from '@wallet/db';
import { NotFoundError, AuthorizationDeniedError } from '@wallet/errors';
import { logSecurityEvent, type Logger } from '@wallet/logger';

export interface CustodyServiceDeps {
  readonly db: PrismaClient;
  readonly deriver: AddressDeriver;
  readonly validator: AddressValidator;
  readonly chain: string;
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

export function createCustodyService(deps: CustodyServiceDeps): CustodyService {
  const custody = createCustodyRepository(deps.db);
  const ledger = createLedgerRepository(deps.db);

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

      // The index claim and the address insert are one transaction. The claim
      // takes an advisory lock, so two concurrent first-requests cannot derive
      // the same index — which would give two users the same address and
      // misattribute every deposit to whichever row was written first.
      return withTransaction(deps.db, async (tx) => {
        const again = await custody.findActiveDepositAddress(wallet.id, tx);
        if (again) return again;

        const index = await custody.claimNextDerivationIndex(deps.chain, tx);
        const derived = deps.deriver.derive(index);

        // Derivation should never produce an invalid address; if it does, that
        // is a bug in the deriver and a user must not be handed the result.
        const verdict = deps.validator.isWellFormed(derived.address);
        if (!verdict.ok) {
          throw new Error(`derived an invalid address at index ${index}: ${verdict.reason}`);
        }

        const created = await custody.createAddress(
          {
            walletId: wallet.id,
            chain: deps.chain,
            address: derived.address,
            derivationIndex: derived.derivationIndex,
            derivationPath: derived.derivationPath,
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
      const held = await ledger.getUserBalances(userId);
      const byAsset = new Map(held.map((row) => [row.asset, row]));

      return deps.assets.map(
        (asset) => byAsset.get(asset) ?? { asset, available: '0', locked: '0', total: '0' },
      );
    },
  };
}
