/**
 * Reconciliation, as a script (prompt_phase2.md rule 164).
 *
 *   pnpm --filter @wallet/api reconcile
 *
 * Scheduling, alerting, and an operator UI are Phase 4. What matters now is
 * that the comparison exists, reads from ledger entries, and can be run by a
 * human during an incident.
 *
 * Exit code 1 on drift, so it is usable from cron or CI without parsing the
 * output.
 */
import { loadApiConfigOrExit } from '@wallet/config';
import { createLogger } from '@wallet/logger';
import { createPrismaClient } from '@wallet/db';
import { createSolanaAdapter, NATIVE_DECIMALS, solanaChainId } from '@wallet/solana';
import type { Cluster } from '@wallet/types';
import {
  createClearingReconciliationService,
  type ClearingReport,
} from '../services/clearing-reconciliation.service.js';
import { createReconciliationService } from '../services/reconciliation.service.js';
import { createHttpEngineClient, engineKeyFromSeed } from '../services/trading/engine-client.js';
import { createMarketRegistry } from '../services/trading/markets.js';

const config = loadApiConfigOrExit();
const logger = createLogger({ level: config.shared.logLevel });

function format(baseUnits: string, decimals: number): string {
  const negative = baseUnits.startsWith('-');
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${rendered}` : rendered;
}

async function main(): Promise<void> {
  const db = createPrismaClient({ url: config.database.url });

  /*
   * The cluster comes from `--cluster`, defaulting to the configured default
   * (ADR-0021). An operator reconciling "the wallet" on a multi-cluster
   * deployment must be told which books they are looking at, because a devnet
   * residual and a mainnet residual demand very different responses.
   */
  const requested = process.argv.find((argument) => argument.startsWith('--cluster='));
  const cluster = (requested?.split('=')[1] ?? config.chain.defaultCluster) as Cluster;

  const chain = config.chain.byCluster[cluster];
  if (!chain) {
    process.stderr.write(
      `\n  ✗ this deployment does not serve ${cluster}; it serves ` +
        `${config.chain.clusters.join(', ')}\n\n`,
    );
    process.exit(1);
  }

  const adapter = createSolanaAdapter({
    cluster,
    endpoint: chain.rpcUrl,
    commitment: config.chain.commitment,
    requestTimeoutMs: config.chain.rpcTimeoutMs,
    maxRetries: config.chain.rpcMaxRetries,
    pageSize: config.indexer.pageSize,
  });

  const reconciliation = createReconciliationService({
    db,
    reader: adapter,
    chain: solanaChainId(cluster),
    cluster,
    logger,
  });

  const report = await reconciliation.run();

  /*
   * The clearing tier (ADR-0035), when this deployment trades on this cluster.
   * The scheduled worker alerts on these checks by name only; this is where a
   * person reads the numbers behind an alert.
   */
  let clearing: ClearingReport | null = null;
  if (config.trading.enabled && cluster === config.chain.defaultCluster) {
    const key = engineKeyFromSeed(config.trading.engineCallerSeed);
    const markets = createMarketRegistry({
      cluster,
      assets: chain.assets,
      markets: config.trading.markets,
      engines: new Map(
        config.trading.markets.map((market) => [
          market.symbol,
          createHttpEngineClient({
            market: market.symbol,
            baseUrl: config.trading.engineUrls[market.symbol] ?? '',
            key,
            timeoutMs: config.trading.engineTimeoutMs,
          }),
        ]),
      ),
      logger,
    });
    clearing = await createClearingReconciliationService({
      db,
      reader: adapter,
      cluster,
      clearingAddress: config.trading.clearingAddress,
      nativeAsset: chain.assets.nativeKey,
      reserve: BigInt(config.trading.clearingReserve),
      markets: markets.entries,
      consumer: 'settlement',
    }).run();
  }

  // Written to stdout for a human, not through the structured logger: the
  // logger's allowlist deliberately excludes amounts, and this report is
  // nothing but amounts.
  const out = process.stdout;
  out.write(`\nReconciliation — ${report.runAt}\n`);
  out.write(`${'-'.repeat(72)}\n`);

  for (const asset of report.assets) {
    const d = NATIVE_DECIMALS;
    out.write(`\n  ${asset.asset}\n`);
    out.write(`    owed to users        ${format(asset.userLiabilities, d).padStart(24)}\n`);
    out.write(`    ledger chain assets  ${format(asset.ledgerChainAssets, d).padStart(24)}\n`);
    out.write(`    observed on-chain    ${format(asset.observedChainAssets, d).padStart(24)}\n`);
    out.write(`    held as rent         ${format(asset.houseRent, d).padStart(24)}\n`);
    out.write(`    fees                 ${format(asset.houseFees, d).padStart(24)}\n`);
    out.write(`    residual             ${format(asset.residual, d).padStart(24)}\n`);
    out.write(`    addresses checked    ${String(asset.addressesChecked).padStart(24)}\n`);
    out.write(`\n    ${asset.explanation}\n`);
  }

  // One reading. The scheduled worker alerts on a STREAK of these, because an
  // allocation in flight makes a single drifting reading normal — except a
  // negative trading balance, which nothing legitimate produces.
  let clearingClean = true;
  if (clearing) {
    out.write(`\n${'-'.repeat(72)}\n  Clearing tier (ADR-0035)\n`);
    for (const finding of clearing.findings) {
      if (finding.status === 'drift') clearingClean = false;
      out.write(`\n  ${finding.check.padEnd(12)} ${finding.subject}  ${finding.status}\n`);
      for (const [name, value] of Object.entries(finding.detail)) {
        out.write(`    ${name.padEnd(24)} ${value.padStart(24)}\n`);
      }
    }
    if (clearing.negativeTradingAccounts > 0) clearingClean = false;
    out.write(
      `\n  negative trading balances  ${String(clearing.negativeTradingAccounts)}` +
        `${clearing.negativeTradingAccounts > 0 ? '  <- ALERT ON THE FIRST READING' : ''}\n`,
    );
  }

  const healthy = report.healthy && clearingClean;
  out.write(`\n${'-'.repeat(72)}\n`);
  out.write(
    healthy
      ? '  RECONCILED\n\n'
      : '  DRIFT DETECTED — see docs/runbooks/reconciliation-drift.md\n\n',
  );

  await db.$disconnect();
  process.exit(healthy ? 0 : 1);
}

main().catch((error: unknown) => {
  logger.fatal('reconciliation failed', {
    errorName: error instanceof Error ? error.name : typeof error,
  });
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
