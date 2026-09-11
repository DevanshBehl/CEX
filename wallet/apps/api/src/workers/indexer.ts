import type { ChainAdapter } from '@wallet/blockchain';
import { createCursorRepository, createCustodyRepository, type PrismaClient } from '@wallet/db';
import { logSecurityEvent, runWithContext, type Logger } from '@wallet/logger';
import { randomUUID } from 'node:crypto';
import type { DepositPipeline } from '../services/deposit.service.js';

export interface IndexerOptions {
  readonly chain: string;
  readonly pollIntervalMs: number;
  readonly pageSize: number;
  readonly maxAddressesPerCycle: number;
}

export interface IndexerDeps {
  readonly db: PrismaClient;
  readonly adapter: ChainAdapter;
  readonly pipeline: DepositPipeline;
  readonly logger: Logger;
  readonly options: IndexerOptions;
  /**
   * The token accounts to poll for a deposit address (ADR-0016).
   *
   * Injected rather than derived here: deriving an associated token address is
   * chain-specific, and this worker must not know what a mint is (rule 25).
   * The composition root supplies a function that knows both.
   *
   * Returns an empty list when no mints are allowlisted, so a SOL-only
   * deployment does exactly what it did before.
   */
  readonly tokenAccounts: (address: {
    addressId: string;
    address: string;
  }) => Promise<readonly { address: string }[]>;
}

export interface IndexerCycleResult {
  readonly addressesPolled: number;
  readonly transfersSeen: number;
  readonly credited: number;
  readonly duplicates: number;
  readonly notFinal: number;
  readonly failures: number;
}

export interface Indexer {
  /** One pass over the watch set. Exposed so tests drive it deterministically. */
  runOnce(): Promise<IndexerCycleResult>;
  start(): void;
  stop(): Promise<void>;
}

/**
 * The deposit indexer (prompt_phase2.md rules 145-148, ADR-0007).
 *
 * THE ORDERING THAT MATTERS
 *
 *   1. read the cursor
 *   2. fetch a page of transfers after it
 *   3. process every transfer, each in its own database transaction
 *   4. ONLY THEN persist the new cursor
 *
 * Step 4 last is the whole of restart safety (rules 146-147). A crash between
 * 3 and 4 re-reads the page on restart, and re-reading is a no-op because the
 * deposit uniqueness constraint rejects the duplicates. A crash after a cursor
 * written first would skip the page permanently, and a skipped deposit is money
 * a user sent that never arrives — silently, with nothing to alert on.
 *
 * The asymmetry is the point: re-processing is cheap and safe, skipping is
 * unrecoverable. When in doubt the cursor lags.
 */
export function createIndexer(deps: IndexerDeps): Indexer {
  const custody = createCustodyRepository(deps.db);
  const cursors = createCursorRepository(deps.db);
  const { options } = deps;

  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function pollAddress(
    watched: Awaited<ReturnType<typeof custody.listWatched>>[number],
    result: { transfersSeen: number; credited: number; duplicates: number; notFinal: number },
    /** Where to look. Defaults to the deposit address itself. */
    scanAddress: string = watched.address,
    /**
     * The cursor to advance. Token accounts get their own row, keyed on the
     * account actually scanned.
     */
    cursorScanAddress: string = watched.address,
  ): Promise<void> {
    /**
     * THE ADDRESS POLLED IS NOT ALWAYS THE ADDRESS CREDITED.
     *
     * A SOL transfer touches the deposit address itself, so
     * `getSignaturesForAddress(depositAddress)` finds it.
     *
     * A TOKEN transfer does not. It moves between token accounts, and the
     * owner's own address is not among the transaction's account keys — so
     * polling the owner returns nothing, forever. Verified against a real
     * validator: a mint to a deposit address's token account produced **1**
     * signature for the token account and **0** for the owner.
     *
     * So each watched address is polled at its own address AND at every
     * derived token account for an allowlisted mint (ADR-0016). The
     * `scanAddress` is where to look; `watched.address` remains who to credit,
     * because `parseTokenTransfers` matches on the token account's OWNER.
     *
     * This is the discovery half of token deposits. No unit test with a
     * fabricated transaction could have caught it: the parsing was correct the
     * whole time, and nothing was ever fetched to parse.
     */
    const page = await deps.adapter.fetchTransfers({
      address: scanAddress,
      // Who to credit, when the scanned account is not the deposit address.
      ...(scanAddress === watched.address ? {} : { creditTo: watched.address }),
      cursor: watched.cursor,
      pageSize: options.pageSize,
    });

    if (page.transfers.length === 0) {
      // Nothing found, but the poll happened. Recording that separates
      // "healthy and quiet" from "not being polled at all", which otherwise
      // look identical from the outside.
      await cursors.touch(
        { addressId: watched.addressId, scanAddress: cursorScanAddress },
        options.chain,
      );
      if (page.nextCursor !== null && page.nextCursor !== watched.cursor) {
        await cursors.advance({
          addressId: watched.addressId,
          scanAddress: cursorScanAddress,
          chain: options.chain,
          signature: page.nextCursor,
          position: null,
        });
      }
      return;
    }

    result.transfersSeen += page.transfers.length;

    /**
     * The rent-exempt minimum is read per cycle rather than hardcoded
     * (rule 114). It is a network parameter; a stale constant would
     * misattribute the split between a user's balance and house_rent.
     *
     * ONLY FOR THE NATIVE ASSET. Rent is denominated in the chain's own
     * currency, so there is no such thing as a rent minimum "in USDC" — asking
     * for one threw a ChainError that failed the entire poll, which is how
     * token deposits were discovered and then dropped.
     *
     * A token account's rent is real and IS paid, in the native asset, as a
     * house expense (`postTokenAccountRent`) — never deducted from the token
     * amount a user receives (ADR-0016 rule 118).
     */
    const firstAsset = page.transfers[0]!.asset;
    const rentReserved =
      scanAddress === watched.address
        ? await deps.adapter.getMinimumAccountBalance(firstAsset)
        : '0';

    let highestProcessed: string | null = null;
    let highestPosition: bigint | null = null;

    for (const transfer of page.transfers) {
      // Rent is only reserved by the transfer that FIRST funds an address.
      // Every later deposit to the same address is fully creditable, because
      // the minimum is already sitting there.
      const existing = await deps.db.deposit.count({ where: { addressId: watched.addressId } });
      const applicableRent = existing === 0 ? rentReserved : '0';

      const outcome = await deps.pipeline.creditTransfer(transfer, applicableRent);

      if (outcome.outcome === 'credited') result.credited += 1;
      else if (outcome.outcome === 'duplicate') result.duplicates += 1;
      else if (outcome.outcome === 'not_final') {
        result.notFinal += 1;
        // Not settled yet. The cursor must NOT advance past it, or the next
        // poll will never see it again.
        break;
      }

      highestProcessed = transfer.txReference;
      highestPosition = transfer.position;
    }

    // Step 4. Only what was actually committed.
    if (highestProcessed !== null) {
      await cursors.advance({
        addressId: watched.addressId,
        scanAddress: cursorScanAddress,
        chain: options.chain,
        signature: highestProcessed,
        position: highestPosition,
      });
      deps.logger.debug('indexer.cursor_advanced', {
        event: 'indexer.cursor_advanced',
        targetType: 'address',
        targetId: watched.addressId,
      });
    }
  }

  async function runOnce(): Promise<IndexerCycleResult> {
    const result = {
      addressesPolled: 0,
      transfersSeen: 0,
      credited: 0,
      duplicates: 0,
      notFinal: 0,
      failures: 0,
    };

    const watched = await custody.listWatched(options.chain, options.maxAddressesPerCycle);

    for (const address of watched) {
      if (stopping) break;
      result.addressesPolled += 1;
      try {
        // The deposit address itself, for native transfers.
        await pollAddress(address, result);

        /*
         * And every allowlisted mint's token account for it.
         *
         * Each gets its OWN cursor row, keyed on the token account's id —
         * sharing one cursor across the address and its token accounts would
         * make advancing past a SOL transfer skip unseen token transfers, and
         * the loss would be silent.
         */
        for (const tokenAccount of await deps.tokenAccounts(address)) {
          if (stopping) break;
          await pollAddress(address, result, tokenAccount.address, tokenAccount.address);
        }
      } catch (error) {
        // One address failing must not stop the cycle. The cursor for this
        // address is simply not advanced, so the next cycle retries from the
        // same place.
        result.failures += 1;
        logSecurityEvent(deps.logger, 'indexer.poll_failed', {
          outcome: 'failure',
          targetType: 'address',
          targetId: address.addressId,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }

    return result;
  }

  return {
    runOnce,

    start() {
      if (running) return;
      running = true;
      stopping = false;

      const tick = async (): Promise<void> => {
        if (stopping) return;
        // Each cycle gets its own correlation id, so every line it emits — and
        // every deposit it credits — is traceable to one pass.
        await runWithContext({ correlationId: randomUUID(), route: 'worker:indexer' }, async () => {
          try {
            const result = await runOnce();
            if (result.credited > 0 || result.failures > 0) {
              deps.logger.info('indexer cycle', {
                event: 'deposit.detected',
                count: result.credited,
                total: result.transfersSeen,
              });
            }
          } catch (error) {
            deps.logger.error('indexer cycle failed', {
              errorName: error instanceof Error ? error.name : 'unknown',
            });
          }
        });
        if (!stopping) timer = setTimeout(() => void (inFlight = tick()), options.pollIntervalMs);
      };

      inFlight = tick();
    },

    async stop() {
      stopping = true;
      running = false;
      if (timer) clearTimeout(timer);
      // Let the current cycle finish rather than tearing down mid-transaction.
      await inFlight.catch(() => undefined);
    },
  };
}
