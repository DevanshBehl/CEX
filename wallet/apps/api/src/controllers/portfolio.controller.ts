import type { FastifyRequest } from 'fastify';
import { ValidationError } from '@wallet/errors';
import { formatUsd } from '@wallet/portfolio';
import { isPortfolioRange, type PortfolioRange } from '@wallet/portfolio';
import {
  parseLedgerAssetKey,
  type AssetRegistry,
  type Cluster,
  type PortfolioHistoryResponse,
  type PortfolioSummaryResponse,
} from '@wallet/types';
import { requireSessionRecord } from '../middleware/guards.js';
import type { PortfolioService } from '../services/portfolio.service.js';

export interface PortfolioControllerDeps {
  /** Per-cluster, like every other controller (ADR-0021). */
  readonly runtimeFor: (cluster: Cluster) => {
    readonly portfolio: PortfolioService;
    readonly assets: AssetRegistry;
  };
}

export interface PortfolioControllers {
  history(request: FastifyRequest): Promise<PortfolioHistoryResponse>;
  summary(request: FastifyRequest): Promise<PortfolioSummaryResponse>;
}

export function createPortfolioControllers(deps: PortfolioControllerDeps): PortfolioControllers {
  /** Storage speaks cluster-qualified keys; the wire speaks bare assets. */
  const wireAsset = (assetKey: string): string => {
    try {
      return parseLedgerAssetKey(assetKey).asset;
    } catch {
      return assetKey;
    }
  };

  return {
    async history(request) {
      const { userId } = requireSessionRecord(request);
      const { range } = request.query as { range?: string };

      const requested = range ?? '24h';
      if (!isPortfolioRange(requested)) {
        // Named rather than defaulted: a client asking for `1y` and being
        // handed 24 hours would render a year's worth of axis labels over a
        // day of data.
        throw new ValidationError(
          [{ path: 'range', message: 'unsupported_range' }],
          'Unsupported portfolio range',
        );
      }

      const runtime = deps.runtimeFor(request.cluster);
      const history = await runtime.portfolio.history(userId, requested as PortfolioRange);

      return {
        cluster: history.cluster,
        range: history.range,
        points: history.points.map((point) => ({
          at: point.at.toISOString(),
          totalUsd: formatUsd(point.totalUsd),
          complete: point.complete,
        })),
        truncated: history.truncated,
      };
    },

    async summary(request) {
      const { userId } = requireSessionRecord(request);
      const runtime = deps.runtimeFor(request.cluster);
      const result = await runtime.portfolio.summary(userId);

      return {
        cluster: result.cluster,
        totalUsd: formatUsd(result.summary.totalUsd),
        changeUsd: result.summary.changeUsd === null ? null : formatUsd(result.summary.changeUsd),
        changeBps: result.summary.changeBps,
        allocations: result.summary.allocations.map((allocation) => ({
          asset: wireAsset(allocation.asset),
          symbol: runtime.assets.symbolOf(allocation.asset),
          amount: allocation.amount.toString(),
          decimals: runtime.assets.decimalsOf(allocation.asset),
          valueUsd: allocation.valueUsd === null ? null : formatUsd(allocation.valueUsd),
          shareBps: allocation.shareBps,
          changeUsd: allocation.changeUsd === null ? null : formatUsd(allocation.changeUsd),
        })),
        complete: result.summary.complete,
        truncated: result.truncated,
      };
    },
  };
}
