/**
 * Fill the durable-nonce pool, as a script.
 *
 *   pnpm --filter @wallet/api provision-nonces
 *
 * WHY THIS EXISTS
 *
 * Phase 3 built the pool and the lease protocol, but only the test helpers ever
 * put anything in it — against the fake chain. On a real validator the pool
 * starts empty, every signing cycle logs `nonce.pool_exhausted`, and no
 * withdrawal can be built. This is the operator-side counterpart the helpers
 * stood in for.
 *
 * Idempotent by pool size, not by run: it tops the pool up to
 * `NONCE_POOL_SIZE` and creates nothing when it is already full.
 *
 * NOT DONE HERE: the rent is not posted to the ledger. Treasury funding is not
 * in the ledger either, so posting one side without the other would make the
 * books less true, not more. Both belong to the Phase 4 accounting work
 * (`postHouseFunding`/`postNonceAccountRent` exist and are unused); until then
 * reconciliation reports the treasury balance as drift, which is correct.
 */
import { loadApiConfigOrExit } from '@wallet/config';
import { createLogger } from '@wallet/logger';
import { createNonceAccountRepository, createPrismaClient } from '@wallet/db';
import { createPrivateKey } from 'node:crypto';
import { signAuthorization } from '@wallet/blockchain';
import type { Signer } from '@wallet/blockchain';
import type { Cluster } from '@wallet/types';
import { createRustSigner } from '@wallet/blockchain';
import {
  createNonceManager,
  createSolanaRpc,
  createWithdrawalBroadcaster,
  provisionNonceAccount,
  solanaChainId,
} from '@wallet/solana';

const config = loadApiConfigOrExit();
const logger = createLogger({ level: config.shared.logLevel });

function buildSigner(): Signer {
  if (config.withdrawal.signerKind !== 'real') {
    throw new Error(
      'Refusing to provision nonce accounts with a mock signer: the payer is the treasury ' +
        'and a mock signature will be rejected by the chain. Set SIGNER_KIND=real.',
    );
  }
  return createRustSigner({
    endpoint: config.withdrawal.mpc.endpoint,
    clientPrivateKey: createPrivateKey(
      Buffer.from(config.withdrawal.mpc.clientPrivateKey, 'base64').toString('utf8'),
    ),
    callerName: config.withdrawal.mpc.callerName,
    requestTimeoutMs: config.withdrawal.mpc.timeoutMs,
  });
}

async function main(): Promise<void> {
  const db = createPrismaClient({ url: config.database.url });
  const nonceAccounts = createNonceAccountRepository(db);
  const signer = buildSigner();

  /*
   * Nonce pools are PER CLUSTER (ADR-0021): a devnet transaction must never
   * consume a mainnet durable nonce, and the `chain` column on every row is
   * what keeps the two pools apart. The cluster comes from `--cluster`,
   * defaulting to the configured default.
   */
  const requested = process.argv.find((argument) => argument.startsWith('--cluster='));
  const cluster = (requested?.split('=')[1] ?? config.chain.defaultCluster) as Cluster;

  const chainConfig = config.chain.byCluster[cluster];
  if (!chainConfig) {
    process.stderr.write(
      `\n  ✗ this deployment does not serve ${cluster}; it serves ` +
        `${config.chain.clusters.join(', ')}\n\n`,
    );
    process.exit(1);
  }

  const chain = solanaChainId(cluster);

  const rpc = createSolanaRpc({
    endpoint: chainConfig.rpcUrl,
    commitment: config.chain.commitment,
    requestTimeoutMs: config.chain.rpcTimeoutMs,
    maxRetries: config.chain.rpcMaxRetries,
  });
  const nonces = createNonceManager(rpc);
  const broadcaster = createWithdrawalBroadcaster(rpc);

  const target = config.withdrawal.noncePoolSize;
  const existing = await nonceAccounts.listAll(chain);

  const out = process.stdout;
  out.write(`\nNonce pool — ${chain}\n`);

  /**
   * USABLE accounts, not rows.
   *
   * Counting rows says "full" in two situations where nothing can actually be
   * leased:
   *
   *   - A row whose account does not exist on chain. The API test helpers
   *     provision against a fake chain and leave rows behind; a withdrawal
   *     that leases one fails at broadcast with "nonce account has no
   *     on-chain state".
   *   - A row stuck `leased` by a withdrawal that crashed. The lease is never
   *     returned, so the account is permanently unavailable.
   *   - A row whose on-chain AUTHORITY is not the configured treasury. A
   *     durable nonce can only be advanced by its authority, so one created
   *     under a previous treasury key is inert: every withdrawal that leases
   *     it is signed, broadcast, and rejected by the runtime. Found the hard
   *     way after a key ceremony produced a new house key while three
   *     perfectly healthy-looking nonce accounts stayed in the pool.
   *
   * All three are the normal state of a development database, and all three
   * produce the same symptom — failures at signing or broadcast while this
   * script insists the pool is full.
   */
  const authority = config.withdrawal.treasuryAddress ?? '';

  const onChain = await Promise.all(
    existing.map(async (account) => {
      const state = await nonces.readNonce(account.address).catch(() => null);
      return {
        account,
        exists: state !== null,
        // An account whose authority we cannot sign for is not ours to use.
        ours: state !== null && (authority === '' || state.authority === authority),
      };
    }),
  );

  const usable = onChain.filter(
    (entry) => entry.exists && entry.ours && entry.account.status === 'available',
  );
  const phantom = onChain.filter((entry) => !entry.exists);
  const foreign = onChain.filter((entry) => entry.exists && !entry.ours);
  const stuck = onChain.filter(
    (entry) => entry.exists && entry.ours && entry.account.status === 'leased',
  );

  out.write(`  target ${String(target)}\n`);
  out.write(`  rows ${String(existing.length)}, usable ${String(usable.length)}\n`);
  if (phantom.length > 0) {
    out.write(`  ${String(phantom.length)} recorded but NOT on chain (test residue)\n`);
  }
  if (stuck.length > 0) {
    out.write(`  ${String(stuck.length)} leased — in flight, or stranded by a crash\n`);
  }
  if (foreign.length > 0) {
    /*
     * Retired, not merely reported.
     *
     * An account the treasury cannot advance will never become usable, and
     * leaving it `available` means a withdrawal leases it, gets signed, and is
     * rejected by the runtime — after a nonce round has already been spent.
     * Retiring is the only correct disposition, and it costs nothing: the rent
     * stays where it is and the row remains for the audit trail.
     */
    out.write(
      `  ${String(foreign.length)} authorised by a DIFFERENT key than TREASURY_ADDRESS — retiring\n`,
    );
    for (const entry of foreign) {
      await db.nonceAccount.update({
        where: { id: entry.account.id },
        data: { status: 'retired' },
      });
      out.write(`    retired ${entry.account.address}\n`);
    }
  }

  const missing = target - usable.length;

  if (missing <= 0) {
    out.write('  pool has enough usable accounts; nothing to do\n\n');
    await db.$disconnect();
    return;
  }

  const treasury = config.withdrawal.treasuryAddress;
  if (treasury === undefined || treasury.trim() === '') {
    throw new Error('TREASURY_ADDRESS is not set; there is no account to pay the rent.');
  }

  for (let created = 0; created < missing; created += 1) {
    const result = await provisionNonceAccount({
      nonces,
      broadcast: async (signedTransaction) => {
        const outcome = await broadcaster.broadcast(signedTransaction);
        if (outcome.kind !== 'submitted') {
          throw new Error(`broadcast returned ${outcome.kind}`);
        }
        return { signature: outcome.signature };
      },
      payer: treasury,
      authority: treasury,
      signPayer: async (message) => {
        // One request id per address, so a re-run after a crash mid-broadcast
        // cannot be answered with a cached signature over different bytes
        // (ADR-0013).
        const requestId = `nonce-provision:${Date.now().toString()}:${String(created)}`;
        const unsigned = {
          approvedBy: 'operator:provision-nonces',
          approvedAt: new Date().toISOString(),
          policyVersion: '1',
          reference: requestId,
        };
        const approvalKey = config.withdrawal.mpc.approvalPrivateKey;
        const authorization =
          approvalKey.trim() === ''
            ? unsigned
            : signAuthorization(
                unsigned,
                message,
                createPrivateKey(Buffer.from(approvalKey, 'base64').toString('utf8')),
              );

        const signed = await signer.sign({
          requestId,
          keyRef: { id: config.withdrawal.signerKeyRef },
          payload: message,
          authorization,
        });
        return signed.signature;
      },
    });

    await nonceAccounts.create({
      chain: chain,
      address: result.address,
      currentNonce: result.nonce,
    });

    logger.info('nonce account provisioned', {
      event: 'nonce.provisioned',
      outcome: 'success',
      targetType: 'nonce_account',
    });
    out.write(`  created ${result.address}  (${result.lamports} lamports rent)\n`);
  }

  out.write(`\n  pool now holds ${String(target)} accounts\n\n`);
  await db.$disconnect();
}

main().catch((error: unknown) => {
  logger.error('nonce provisioning failed', {
    errorName: error instanceof Error ? error.name : typeof error,
  });
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
