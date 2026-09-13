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
import {
  NATIVE_ASSET_KEY,
  parseLedgerAssetKey,
  type AssetRegistry,
  type Cluster,
} from '@wallet/types';
import { requireSessionRecord } from '../middleware/guards.js';
import type { CustodyService } from '../services/custody.service.js';

export interface CustodyControllerDeps {
  readonly db: PrismaClient;
  /**
   * The per-cluster object graph for a request (ADR-0021).
   *
   * A function rather than a single service: the same user has a different
   * address, a different balance and a different deposit history on each
   * cluster, and the answer must come from the one the request named.
   */
  readonly runtimeFor: (cluster: Cluster) => {
    readonly custody: CustodyService;
    readonly chainId: string;
    readonly assets: AssetRegistry;
  };
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

  /**
   * The wire speaks bare assets; storage speaks cluster-qualified keys.
   *
   * The cluster is already in the request's context, so repeating it in every
   * balance row would be noise — and a client that rendered `devnet:SOL` as a
   * ticker would be showing an implementation detail to a person.
   */
  const wireAsset = (assetKey: string): string => {
    try {
      return parseLedgerAssetKey(assetKey).asset;
    } catch {
      // A legacy row from before the cluster dimension. Rendered as-is rather
      // than hidden: a balance that exists must be visible.
      return assetKey;
    }
  };

  return {
    async getDepositAddress(request) {
      const { userId } = requireSessionRecord(request);
      const runtime = deps.runtimeFor(request.cluster);
      const address = await runtime.custody.getOrCreateDepositAddress(userId);
      return {
        walletId: address.walletId,
        address: {
          id: address.id,
          chain: address.chain,
          address: address.address,
          asset: NATIVE_ASSET_KEY,
          network: request.cluster,
          createdAt: address.createdAt.toISOString(),
        },
      };
    },

    async listAddresses(request) {
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      const runtime = deps.runtimeFor(request.cluster);
      const addresses = await runtime.custody.listAddresses(userId, id);
      return {
        walletId: id,
        addresses: addresses.map((address) => ({
          id: address.id,
          chain: address.chain,
          address: address.address,
          asset: NATIVE_ASSET_KEY,
          network: request.cluster,
          createdAt: address.createdAt.toISOString(),
        })),
      };
    },

    async listBalances(request) {
      const { userId } = requireSessionRecord(request);
      const runtime = deps.runtimeFor(request.cluster);
      const balances = await runtime.custody.getBalances(userId);
      return {
        cluster: request.cluster,
        balances: balances.map((balance) => ({
          ...balance,
          asset: wireAsset(balance.asset),
          symbol: runtime.assets.symbolOf(balance.asset),
          decimals: runtime.assets.decimalsOf(balance.asset),
        })) as ListBalancesResponse['balances'],
      };
    },

    async listDeposits(request) {
      const { userId } = requireSessionRecord(request);
      const runtime = deps.runtimeFor(request.cluster);
      // Scoped to the cluster: a deposit on devnet is not part of the mainnet
      // history, and merging the two would make the list unreadable and the
      // totals wrong.
      const rows = await deposits.listForUser(userId, 100, runtime.chainId);
      return {
        deposits: rows.map((row) =>
          toDeposit(row, runtime.assets.decimalsOf(row.asset), wireAsset(row.asset)),
        ),
      };
    },

    async getDeposit(request) {
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      const runtime = deps.runtimeFor(request.cluster);
      const row = await deposits.findById(id);
      // Another user's deposit is reported as not found, never as forbidden —
      // a 403 would confirm the id exists (rule 168). The same is true of a
      // deposit belonging to another cluster: from this context it does not
      // exist.
      if (!row || row.userId !== userId || row.chain !== runtime.chainId) {
        throw new NotFoundError('Deposit not found');
      }
      return {
        deposit: toDeposit(row, runtime.assets.decimalsOf(row.asset), wireAsset(row.asset)),
      };
    },
  };
}

function toDeposit(row: DepositRecord, decimals: number, asset: string): Deposit {
  // Surfaced separately so the gap between what arrived and what was credited
  // is visible rather than looking like a lost amount (rules 157-158).
  const credited = (BigInt(row.amount) - BigInt(row.rentReserved)).toString();

  return {
    id: row.id,
    asset,
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
