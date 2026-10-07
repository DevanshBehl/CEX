/**
 * Credit a trading balance from the command line — FOR THE END-TO-END SUITE
 * ONLY.
 *
 *   tsx test/credit-trading-cli.ts <user id> <asset> <base units>
 *
 * This posts a ledger credit with no coins behind it, exactly as the
 * integration suite's `creditTrading` does. It is what a real deployment must
 * NEVER do (ADR-0038 §3): reconciliation check 1 would report the amount
 * missing from the clearing address, correctly. It lives under `test/`, is not
 * built into the API, and refuses to run anywhere but localnet.
 *
 * It exists because the browser journey this serves exercises the trading
 * screen, not custody: a real allocation needs a validator and a signer that
 * can actually sign, and that leg is covered separately.
 */
import { createLedgerRepository, createPrismaClient, newId, withTransaction } from '@wallet/db';

async function main(): Promise<void> {
  const [userId, asset, amount] = process.argv.slice(2);
  const cluster = process.env.SOLANA_NETWORK ?? 'localnet';
  const url = process.env.DATABASE_URL;
  if (cluster !== 'localnet') throw new Error('refusing to credit a ledger outside localnet');
  if (!url || !userId || !asset || !amount || !/^[1-9]\d*$/.test(amount)) {
    throw new Error('usage: credit-trading-cli <user id> <asset> <base units>');
  }

  const key = `${cluster}:${asset}`;
  const db = createPrismaClient({ url });
  const ledger = createLedgerRepository(db);
  const accounts = [
    { ownerId: null, asset: key, type: 'clearing_assets' as const },
    { ownerId: userId, asset: key, type: 'user_trading_available' as const },
  ];
  await ledger.ensureAccounts(accounts);
  await withTransaction(db, (tx) =>
    createLedgerRepository(tx).postTransaction(
      {
        kind: 'allocation',
        referenceType: 'test-credit',
        referenceId: newId(),
        entries: [
          { account: accounts[0]!, asset: key, amount, direction: 'debit' },
          { account: accounts[1]!, asset: key, amount, direction: 'credit' },
        ],
      },
      tx,
    ),
  );
  await db.$disconnect();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
