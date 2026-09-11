import { Prisma } from '@prisma/client';
import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

export interface WalletRecord {
  id: string;
  userId: string;
  chain: string;
  status: 'active' | 'frozen' | 'closed';
  createdAt: Date;
}

export interface AddressRecord {
  id: string;
  walletId: string;
  chain: string;
  address: string;
  derivationIndex: number;
  derivationPath: string;
  custodyRole: 'deposit' | 'hot' | 'warm' | 'cold';
  status: 'active' | 'retired';
  createdAt: Date;
}

export interface WatchedAddress {
  addressId: string;
  address: string;
  chain: string;
  walletId: string;
  userId: string;
  cursor: string | null;
}

export interface CustodyRepository {
  ensureWallet(userId: string, chain: string, tx?: Executor): Promise<WalletRecord>;
  findWallet(userId: string, chain: string, tx?: Executor): Promise<WalletRecord | null>;
  findWalletById(id: string, tx?: Executor): Promise<WalletRecord | null>;
  listAddresses(walletId: string, tx?: Executor): Promise<AddressRecord[]>;
  findActiveDepositAddress(walletId: string, tx?: Executor): Promise<AddressRecord | null>;
  /** Reserves the next free derivation index for a chain. */
  claimNextDerivationIndex(chain: string, tx?: Executor): Promise<number>;
  createAddress(
    input: Omit<AddressRecord, 'id' | 'createdAt' | 'status'>,
    tx?: Executor,
  ): Promise<AddressRecord>;
  findByAddress(chain: string, address: string, tx?: Executor): Promise<AddressRecord | null>;
  listWatched(chain: string, limit: number, tx?: Executor): Promise<WatchedAddress[]>;
}

export function createCustodyRepository(db: Executor): CustodyRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async ensureWallet(userId, chain, tx) {
      const e = exec(tx);
      const existing = await e.wallet.findUnique({ where: { userId_chain: { userId, chain } } });
      if (existing) return existing;

      try {
        return await e.wallet.create({ data: { id: newId(), userId, chain } });
      } catch (error) {
        // Two concurrent first-deposits for the same user both reach here. The
        // unique constraint decides; the loser re-reads rather than failing.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const found = await e.wallet.findUnique({
            where: { userId_chain: { userId, chain } },
          });
          if (found) return found;
        }
        throw error;
      }
    },

    async findWallet(userId, chain, tx) {
      return exec(tx).wallet.findUnique({ where: { userId_chain: { userId, chain } } });
    },

    async findWalletById(id, tx) {
      return exec(tx).wallet.findUnique({ where: { id } });
    },

    async listAddresses(walletId, tx) {
      return exec(tx).address.findMany({
        where: { walletId },
        orderBy: { createdAt: 'asc' },
      });
    },

    async findActiveDepositAddress(walletId, tx) {
      return exec(tx).address.findFirst({
        where: { walletId, custodyRole: 'deposit', status: 'active' },
        orderBy: { createdAt: 'asc' },
      });
    },

    /**
     * The next derivation index for a chain.
     *
     * Takes an advisory lock rather than reading MAX and adding one. Two
     * concurrent signups would otherwise read the same maximum, derive the same
     * index, and produce the same address for two different users — which is a
     * misattributed deposit, not a constraint violation, because the
     * UNIQUE(chain, derivation_index) would fire only on the second insert and
     * the caller would have already derived the address.
     *
     * The lock is scoped to the chain, so it serializes address creation and
     * nothing else.
     */
    async claimNextDerivationIndex(chain, tx) {
      const e = exec(tx);
      // A stable 32-bit key from the chain name.
      const lockKey = [...chain].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) | 0, 7);
      await e.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const rows = await e.$queryRaw<Array<{ next: number }>>`
        SELECT COALESCE(MAX(derivation_index) + 1, 0) AS next
        FROM addresses WHERE chain = ${chain}
      `;
      return rows[0]?.next ?? 0;
    },

    async createAddress(input, tx) {
      return exec(tx).address.create({
        data: {
          id: newId(),
          walletId: input.walletId,
          chain: input.chain,
          address: input.address,
          derivationIndex: input.derivationIndex,
          derivationPath: input.derivationPath,
          custodyRole: input.custodyRole,
        },
      });
    },

    async findByAddress(chain, address, tx) {
      return exec(tx).address.findUnique({ where: { chain_address: { chain, address } } });
    },

    /** Addresses the indexer should poll, with their cursors. */
    async listWatched(chain, limit, tx) {
      const rows = await exec(tx).address.findMany({
        where: { chain, status: 'active', custodyRole: 'deposit' },
        select: {
          id: true,
          address: true,
          chain: true,
          walletId: true,
          wallet: { select: { userId: true } },
          cursor: { select: { lastSignature: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });

      return rows.map((row) => ({
        addressId: row.id,
        address: row.address,
        chain: row.chain,
        walletId: row.walletId,
        userId: row.wallet.userId,
        cursor: row.cursor?.lastSignature ?? null,
      }));
    },
  };
}
