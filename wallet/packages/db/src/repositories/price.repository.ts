import type { Executor } from '../transaction.js';

/**
 * Spot prices (Task 3).
 *
 * Append-only at the database level: the repository has no update and no
 * delete because the table refuses both. A correction is a new tick.
 */

export interface PriceTickInput {
  readonly cluster: string;
  /** The asset WITHOUT its cluster prefix — `SOL`, or a mint address. */
  readonly asset: string;
  /** Decimal string. Never a number: `NUMERIC(18,6)` deserves better. */
  readonly priceUsd: string;
  readonly source: string;
  readonly recordedAt?: Date;
}

export interface PriceTickRow {
  readonly asset: string;
  readonly priceUsd: string;
  readonly recordedAt: Date;
}

export interface PriceRepository {
  record(ticks: readonly PriceTickInput[], tx?: Executor): Promise<number>;
  /**
   * Every tick for these assets in `[from, to]`, ascending.
   *
   * Plus, for each asset, the LAST tick before `from` — without it the left
   * edge of a chart is unpriced and the line starts at zero, which reads as a
   * portfolio that appeared out of nothing.
   */
  seriesFor(
    cluster: string,
    assets: readonly string[],
    from: Date,
    to: Date,
    tx?: Executor,
  ): Promise<PriceTickRow[]>;
  /** The most recent tick per asset at or before `at`. */
  latestAt(
    cluster: string,
    assets: readonly string[],
    at: Date,
    tx?: Executor,
  ): Promise<PriceTickRow[]>;
}

export function createPriceRepository(db: Executor): PriceRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async record(ticks, tx) {
      if (ticks.length === 0) return 0;

      const result = await exec(tx).assetPriceTick.createMany({
        data: ticks.map((tick) => ({
          cluster: tick.cluster,
          asset: tick.asset,
          priceUsd: tick.priceUsd,
          source: tick.source,
          ...(tick.recordedAt !== undefined ? { recordedAt: tick.recordedAt } : {}),
        })),
      });
      return result.count;
    },

    async seriesFor(cluster, assets, from, to, tx) {
      if (assets.length === 0) return [];

      /*
       * One query, not one per asset.
       *
       * The `UNION` picks up each asset's last tick before the window. A chart
       * whose first point has no price starts at zero and then jumps, and a
       * user reads that as a deposit they did not make.
       */
      const rows = await exec(tx).$queryRaw<
        Array<{ asset: string; price_usd: string; recorded_at: Date }>
      >`
        SELECT asset, price_usd::text AS price_usd, recorded_at
          FROM asset_price_ticks
         WHERE cluster = ${cluster}
           AND asset = ANY(${assets}::text[])
           AND recorded_at BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT t.asset, t.price_usd::text AS price_usd, t.recorded_at
          FROM unnest(${assets}::text[]) AS a(asset)
          CROSS JOIN LATERAL (
            SELECT asset, price_usd, recorded_at
              FROM asset_price_ticks
             WHERE cluster = ${cluster}
               AND asset = a.asset
               AND recorded_at < ${from}
             ORDER BY recorded_at DESC
             LIMIT 1
          ) t
        ORDER BY asset, recorded_at
      `;

      return rows.map(toRow);
    },

    async latestAt(cluster, assets, at, tx) {
      if (assets.length === 0) return [];

      const rows = await exec(tx).$queryRaw<
        Array<{ asset: string; price_usd: string; recorded_at: Date }>
      >`
        SELECT t.asset, t.price_usd::text AS price_usd, t.recorded_at
          FROM unnest(${assets}::text[]) AS a(asset)
          CROSS JOIN LATERAL (
            SELECT asset, price_usd, recorded_at
              FROM asset_price_ticks
             WHERE cluster = ${cluster}
               AND asset = a.asset
               AND recorded_at <= ${at}
             ORDER BY recorded_at DESC
             LIMIT 1
          ) t
      `;

      return rows.map(toRow);
    },
  };
}

function toRow(row: { asset: string; price_usd: string; recorded_at: Date }): PriceTickRow {
  return { asset: row.asset, priceUsd: row.price_usd, recordedAt: row.recorded_at };
}
