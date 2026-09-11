import type { FastifyRequest } from 'fastify';
import type {
  Deposit,
  DepositAddressResponse,
  ListAddressesResponse,
  ListBalancesResponse,
  ListDepositsResponse,
} from '@wallet/types';
import { createDepositRepository, type DepositRecord, type PrismaClient } from '@wallet/db';
import { NotFoundError } from '@wallet/errors';
import { requireSessionRecord } from '../middleware/guards.js';
import type { CustodyService } from '../services/custody.service.js';

export interface CustodyControllerDeps {
  readonly db: PrismaClient;
  readonly custody: CustodyService;
  readonly chain: string;
  readonly network: string;
  readonly nativeAsset: string;
  readonly decimals: Readonly<Record<string, number>>;
}

export interface CustodyControllers {
  getDepositAddress(request: FastifyRequest): Promise<DepositAddressResponse>;
  listAddresses(request: FastifyRequest): Promise<ListAddressesResponse>;
  listBalances(request: FastifyRequest): Promise<ListBalancesResponse>;
  listDeposits(request: FastifyRequest): Promise<ListDepositsResponse>;
  getDeposit(request: FastifyRequest): Promise<{ deposit: Deposit }>;
}

export function createCustodyControllers(deps: CustodyControllerDeps): CustodyControllers {
  const deposits = createDepositRepository(deps.db);
  const decimalsFor = (asset: string): number => deps.decimals[asset] ?? 0;

  return {
    async getDepositAddress(request) {
      const { userId } = requireSessionRecord(request);
      const address = await deps.custody.getOrCreateDepositAddress(userId);
      return {
        walletId: address.walletId,
        address: {
          id: address.id,
          chain: address.chain,
          address: address.address,
          asset: deps.nativeAsset,
          network: deps.network,
          createdAt: address.createdAt.toISOString(),
        },
      };
    },

    async listAddresses(request) {
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      const addresses = await deps.custody.listAddresses(userId, id);
      return {
        walletId: id,
        addresses: addresses.map((address) => ({
          id: address.id,
          chain: address.chain,
          address: address.address,
          asset: deps.nativeAsset,
          network: deps.network,
          createdAt: address.createdAt.toISOString(),
        })),
      };
    },

    async listBalances(request) {
      const { userId } = requireSessionRecord(request);
      const balances = await deps.custody.getBalances(userId);
      return {
        balances: balances.map((balance) => ({
          ...balance,
          decimals: decimalsFor(balance.asset),
        })) as ListBalancesResponse['balances'],
      };
    },

    async listDeposits(request) {
      const { userId } = requireSessionRecord(request);
      const rows = await deposits.listForUser(userId, 100);
      return { deposits: rows.map((row) => toDeposit(row, decimalsFor(row.asset))) };
    },

    async getDeposit(request) {
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      const row = await deposits.findById(id);
      // Another user's deposit is reported as not found, never as forbidden —
      // a 403 would confirm the id exists (rule 168).
      if (!row || row.userId !== userId) throw new NotFoundError('Deposit not found');
      return { deposit: toDeposit(row, decimalsFor(row.asset)) };
    },
  };
}

function toDeposit(row: DepositRecord, decimals: number): Deposit {
  // Surfaced separately so the gap between what arrived and what was credited
  // is visible rather than looking like a lost amount (rules 157-158).
  const credited = (BigInt(row.amount) - BigInt(row.rentReserved)).toString();

  return {
    id: row.id,
    asset: row.asset,
    decimals,
    amount: row.amount,
    rentReserved: row.rentReserved,
    creditedAmount: credited,
    status: row.status,
    txSignature: row.txSignature,
    createdAt: row.createdAt.toISOString(),
    creditedAt: row.creditedAt?.toISOString() ?? null,
  } as Deposit;
}
