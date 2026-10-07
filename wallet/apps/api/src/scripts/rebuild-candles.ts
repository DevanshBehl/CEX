/**
 * Rebuild a market's candles from its trades (ADR-0036 §6).
 *
 *   pnpm --filter @wallet/api rebuild-candles -- --market=devnet:SOL-USDC
 *
 * Candles are DERIVED: a pure function of the `trades` table, which is the
 * record and is not touched here. This drops a market's candles and recomputes
 * every one, in a single transaction, so a reader never sees a half-built
 * chart. A rebuild of a correct table reproduces it exactly; a test holds it
 * to that.
 */
import { loadApiConfigOrExit } from '@wallet/config';
import { createMarketDataRepository, createPrismaClient, withTransaction } from '@wallet/db';

const config = loadApiConfigOrExit();

async function main(): Promise<void> {
  const argument = process.argv.find((value) => value.startsWith('--market='));
  const market = argument?.slice('--market='.length);
  if (!market || !/^[a-z-]+:[A-Z0-9]+-[A-Z0-9]+$/.test(market)) {
    process.stderr.write(
      '\n  ✗ --market=<cluster>:<SYMBOL> is required, e.g. --market=devnet:SOL-USDC\n\n',
    );
    process.exit(2);
  }

  const db = createPrismaClient({ url: config.database.url });
  const rebuilt = await withTransaction(db, (tx) =>
    createMarketDataRepository(tx).rebuildCandles(market, tx),
  );
  process.stdout.write(`\n  ${String(rebuilt)} one-minute candles rebuilt for ${market}\n\n`);
  await db.$disconnect();
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
