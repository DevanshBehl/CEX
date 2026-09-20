import type { KeyObject } from 'node:crypto';
import type { ChainAdapter, Signer } from '@wallet/blockchain';
import type { ApiConfig, ClusterChainConfig } from '@wallet/config';
import type { PrismaClient } from '@wallet/db';
import type { Logger } from '@wallet/logger';
import {
  createNonceManager,
  createSolanaAdapter,
  createSolanaAddressValidator,
  createSolanaRpc,
  createWithdrawalBroadcaster,
  deriveAssociatedTokenAddress,
  solanaChainId,
  type NonceManager,
  type SolanaRpc,
  type WithdrawalBroadcaster,
} from '@wallet/solana';
import type { AssetRegistry, Cluster } from '@wallet/types';
import type { DeadLetterQueue } from '../observability/dead-letter.js';
import type { WalletMetrics } from '../observability/metrics.js';
import {
  createCustodyService,
  userKeyRef,
  type CustodyService,
} from '../services/custody.service.js';
import { createDepositPipeline, type DepositPipeline } from '../services/deposit.service.js';
import { createPortfolioService, type PortfolioService } from '../services/portfolio.service.js';
import { createReconciliationService } from '../services/reconciliation.service.js';
import { createWithdrawalService, type WithdrawalService } from '../services/withdrawal.service.js';
import { createWithdrawalValuation } from '../services/withdrawal-valuation.js';
import { parseUsd } from '@wallet/portfolio';
import { createIndexer, type Indexer } from '../workers/indexer.js';
import { createWithdrawalWorkers, type WithdrawalWorkers } from '../workers/withdrawal-workers.js';
import { createCustodyRepository } from '@wallet/db';
import { createSolanaAddressDeriver } from '@wallet/solana';
import type { KeyProvisioner } from '@wallet/blockchain';

/**
 * Everything that belongs to ONE cluster (ADR-0021).
 *
 * # Why a runtime object rather than a cluster parameter
 *
 * Devnet and mainnet share a database, a signer and an HTTP server, and share
 * nothing else: different endpoints, different addresses, different nonce
 * pools, different indexer cursors, different allowlists, different asset
 * keys. Threading a `cluster` argument through every call would work only for
 * as long as every call site remembered to pass it, and the failure when one
 * did not would be a devnet balance rendered as mainnet money — or a mainnet
 * withdrawal built on a devnet nonce.
 *
 * Holding them as separate object graphs makes that unrepresentable. Code that
 * has the devnet runtime cannot reach mainnet, because there is no reference
 * from one to the other.
 */
export interface ClusterRuntime {
  readonly cluster: Cluster;
  /** `solana:devnet` — what the `chain` column carries. */
  readonly chainId: string;
  readonly adapter: ChainAdapter;
  readonly rpc: SolanaRpc;
  readonly assets: AssetRegistry;
  readonly nonces: NonceManager;
  readonly broadcaster: WithdrawalBroadcaster;
  readonly custody: CustodyService;
  readonly deposits: DepositPipeline;
  readonly withdrawals: WithdrawalService;
  readonly withdrawalWorkers: WithdrawalWorkers;
  readonly indexer: Indexer;
  /** Valuation for this cluster's holdings (Task 3). */
  readonly portfolio: PortfolioService;
  readonly reconcile: () => ReturnType<ReturnType<typeof createReconciliationService>['run']>;
}

export interface ClusterOverrides {
  readonly adapter?: ChainAdapter | undefined;
  readonly nonceManager?: NonceManager | undefined;
  readonly broadcaster?: WithdrawalBroadcaster | undefined;
}

export interface ClusterRuntimeDeps {
  readonly config: ApiConfig;
  readonly chain: ClusterChainConfig;
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly signer: Signer & { readonly kind?: string };
  readonly keyProvisioner: KeyProvisioner | undefined;
  readonly metrics: WalletMetrics;
  readonly deadLetters: DeadLetterQueue;
  readonly approvalKey: KeyObject | undefined;
  /**
   * Test seams, applied to ONE cluster.
   *
   * A suite drives a single cluster — the fakes have no notion of which one
   * they belong to, and injecting the same broadcaster into two clusters would
   * make "did this land?" ambiguous in exactly the way durable nonces exist to
   * prevent.
   */
  readonly overrides?: ClusterOverrides;
}

export function createClusterRuntime(deps: ClusterRuntimeDeps): ClusterRuntime {
  const { config, chain, db, logger } = deps;
  const cluster = chain.cluster;
  const chainId = solanaChainId(cluster);

  const rpcOptions = {
    endpoint: chain.rpcUrl,
    commitment: config.chain.commitment,
    requestTimeoutMs: config.chain.rpcTimeoutMs,
    maxRetries: config.chain.rpcMaxRetries,
  };

  const adapter =
    deps.overrides?.adapter ??
    createSolanaAdapter({ ...rpcOptions, cluster, pageSize: config.indexer.pageSize });

  const rpc = createSolanaRpc(rpcOptions);
  const nonces = deps.overrides?.nonceManager ?? createNonceManager(rpc);
  const broadcaster = deps.overrides?.broadcaster ?? createWithdrawalBroadcaster(rpc);

  const custody = createCustodyService({
    db,
    // The legacy path (ADR-0004). Segregated deployments provision instead.
    deriver: createSolanaAddressDeriver(Buffer.from(config.chain.depositSeed, 'base64')),
    ...(deps.keyProvisioner ? { keys: deps.keyProvisioner } : {}),
    validator: createSolanaAddressValidator(),
    chain: chainId,
    assets: chain.assets.keys,
    logger,
  });

  const deposits = createDepositPipeline({
    db,
    logger,
    assets: chain.assets,
    metrics: deps.metrics,
  });

  /*
   * Risk limits for THIS cluster only.
   *
   * The configured map is keyed by cluster-qualified asset, so the filter is a
   * prefix test rather than a second source of truth — and an asset from
   * another cluster cannot reach this policy even if it is somehow requested.
   */
  const assetLimits = Object.fromEntries(
    Object.entries(config.risk.assetLimits)
      .filter(([asset]) => asset.startsWith(`${cluster}:`))
      .map(([asset, limits]) => [
        asset,
        {
          perTransactionLimit: BigInt(limits.perTransactionLimit),
          dailyLimit: BigInt(limits.dailyLimit),
          manualReviewAbove: BigInt(limits.manualReviewAbove),
        },
      ]),
  );

  const withdrawals = createWithdrawalService({
    db,
    validator: createSolanaAddressValidator(),
    chain: chainId,
    logger,
    valuation: createWithdrawalValuation({
      db,
      cluster,
      assets: chain.assets,
      maxAgeSeconds: config.risk.priceMaxAgeSeconds,
    }),
    policy: {
      // Every asset the platform will credit on this cluster is an asset it
      // must be able to reason about withdrawing (ADR-0016).
      supportedAssets: chain.assets.keys,
      assetLimits,
      perTransactionLimit: BigInt(config.risk.perTransactionLimit),
      dailyLimit: BigInt(config.risk.dailyLimit),
      velocityWindowMinutes: config.risk.velocityWindowMinutes,
      velocityMaxCount: config.risk.velocityMaxCount,
      manualReviewAbove: BigInt(config.risk.manualReviewAbove),
      reviewNewDestinations: config.risk.reviewNewDestinations,
      // One dollar threshold across every asset (ADR-0024).
      manualReviewAboveUsdMicros:
        config.risk.manualReviewAboveUsd === null
          ? null
          : parseUsd(config.risk.manualReviewAboveUsd),
      knownDestinationWindowDays: config.risk.knownDestinationWindowDays,
    },
  });

  const withdrawalWorkers = createWithdrawalWorkers({
    db,
    signer: deps.signer,
    nonces,
    broadcaster,
    logger,
    chain: chainId,
    treasuryAddress: config.withdrawal.treasuryAddress ?? '',
    keyRefId: config.withdrawal.signerKeyRef,
    ...(config.withdrawal.segregatedCustody
      ? {
          segregated: {
            async resolve(userId: string) {
              const repository = createCustodyRepository(db);
              const wallet = await repository.findWallet(userId, chainId);
              const address = wallet ? await repository.findActiveDepositAddress(wallet.id) : null;
              if (!address) {
                // A withdrawal for a user with no address on this cluster
                // means funds were credited without one, which cannot happen
                // through the deposit pipeline. Refusing beats paying from the
                // house and silently commingling.
                throw new Error(`user ${userId} has no segregated address on ${cluster}`);
              }
              return { address: address.address, keyRef: userKeyRef(userId) };
            },
          },
        }
      : {}),
    budgets: config.withdrawal.budgets,
    batchSize: config.withdrawal.workerBatchSize,
    ...(deps.approvalKey !== undefined ? { approvalKey: deps.approvalKey } : {}),
    deadLetters: deps.deadLetters,
    metrics: deps.metrics,
    assets: chain.assets,
    chainReader: adapter,
  });

  const portfolio = createPortfolioService({
    db,
    cluster,
    assets: chain.assets,
  });

  const indexer = createIndexer({
    db,
    adapter,
    pipeline: deposits,
    logger,
    /**
     * Where to look for each allowlisted mint (ADR-0016).
     *
     * A token transfer never touches the owner's address, so polling the
     * deposit address alone finds nothing. Each derived token account is
     * polled separately, with its own cursor — and the cursor rows are keyed
     * by `chain`, which now names the cluster, so devnet and mainnet polling
     * state for the same address cannot collide (ADR-0021).
     */
    tokenAccounts: async (address) =>
      chain.assets.tokens.map((token) => ({
        address: deriveAssociatedTokenAddress(address.address, token.mint),
      })),
    options: {
      chain: chainId,
      pollIntervalMs: config.indexer.pollIntervalMs,
      pageSize: config.indexer.pageSize,
      maxAddressesPerCycle: config.indexer.maxAddressesPerCycle,
    },
  });

  const reconciliation = createReconciliationService({
    db,
    reader: adapter,
    chain: chainId,
    cluster,
    logger,
    /**
     * The treasury is platform-owned and was outside the Phase 3 comparison,
     * which made every residual wrong by exactly its balance (rule 142).
     * Custody tiers join this list as they acquire addresses (ADR-0018).
     */
    platformAddresses:
      config.withdrawal.treasuryAddress !== undefined &&
      config.withdrawal.treasuryAddress.trim() !== ''
        ? [config.withdrawal.treasuryAddress]
        : [],
  });

  return {
    cluster,
    chainId,
    adapter,
    rpc,
    assets: chain.assets,
    nonces,
    broadcaster,
    custody,
    deposits,
    withdrawals,
    withdrawalWorkers,
    indexer,
    portfolio,
    reconcile: () => reconciliation.run(),
  };
}
