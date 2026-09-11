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
import { createSolanaAdapter, NATIVE_DECIMALS, SOLANA_CHAIN_ID } from '@wallet/solana';
import { createReconciliationService } from '../services/reconciliation.service.js';

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
  const adapter = createSolanaAdapter({
    endpoint: config.chain.rpcUrl,
    commitment: config.chain.commitment,
    requestTimeoutMs: config.chain.rpcTimeoutMs,
    maxRetries: config.chain.rpcMaxRetries,
    pageSize: config.indexer.pageSize,
  });

  const reconciliation = createReconciliationService({
    db,
    reader: adapter,
    chain: SOLANA_CHAIN_ID,
    logger,
  });

  const report = await reconciliation.run();

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

  out.write(`\n${'-'.repeat(72)}\n`);
  out.write(
    report.healthy
      ? '  RECONCILED\n\n'
      : '  DRIFT DETECTED — see docs/runbooks/reconciliation-drift.md\n\n',
  );

  await db.$disconnect();
  process.exit(report.healthy ? 0 : 1);
}

main().catch((error: unknown) => {
  logger.fatal('reconciliation failed', {
    errorName: error instanceof Error ? error.name : typeof error,
  });
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
