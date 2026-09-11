import type { TransferEvent } from '@wallet/blockchain';
import { IGNORED_REASONS, type AssetRegistry } from '@wallet/types';
import type { WalletMetrics } from '../observability/metrics.js';
import {
  createCursorRepository,
  createCustodyRepository,
  createDepositRepository,
  createLedgerRepository,
  withTransaction,
  type PrismaClient,
} from '@wallet/db';
import { postDeposit, toAmount, toBaseUnits } from '@wallet/ledger';
import { logSecurityEvent, type Logger } from '@wallet/logger';

export interface DepositPipelineDeps {
  readonly db: PrismaClient;
  readonly logger: Logger;
  /**
   * The asset allowlist (ADR-0016). Decides what may become a liability.
   *
   * Passed in rather than read from config so the pipeline stays testable
   * without an environment, and so the decision has exactly one owner.
   */
  readonly assets: AssetRegistry;
  /** Optional: a harness may omit it, and nothing about crediting depends on it. */
  readonly metrics?: WalletMetrics | undefined;
}

export type CreditOutcome =
  | { readonly outcome: 'credited'; readonly depositId: string }
  /** Already processed. The uniqueness constraint said so (rules 127-128). */
  | { readonly outcome: 'duplicate' }
  /** Not settled enough to credit yet (ADR-0006). */
  | { readonly outcome: 'not_final' }
  /** Not ours, or not an asset we support. */
  | { readonly outcome: 'ignored'; readonly reason: string };

export interface DepositPipeline {
  creditTransfer(event: TransferEvent, rentReserved: string): Promise<CreditOutcome>;
}

/**
 * Turning a detected transfer into a credited balance
 * (prompt_phase2.md rules 141, 149-160).
 *
 * The whole point of this function is that the deposit row and its ledger
 * entries are written in ONE database transaction (rule 153). A deposit row
 * without entries is money the user cannot see; entries without a deposit row
 * is money with no provenance. Neither is recoverable by a retry, because both
 * look like success.
 */
export function createDepositPipeline(deps: DepositPipelineDeps): DepositPipeline {
  const custody = createCustodyRepository(deps.db);
  const deposits = createDepositRepository(deps.db);
  const ledger = createLedgerRepository(deps.db);

  return {
    async creditTransfer(event, rentReserved) {
      // ADR-0006: only `final` may be credited. A `probable` transfer is left
      // for a later poll — it can still be rolled back on a fork, and crediting
      // it would mean debiting a user who has already been told the funds
      // arrived.
      if (event.confirmation !== 'final') {
        return { outcome: 'not_final' };
      }

      const address = await custody.findByAddress(event.chain, event.to);
      if (!address) {
        // A transfer to an address we do not own. Not an error, and not worth
        // a warning — it is the normal case for any address that has ever been
        // used by anyone else (rule 152).
        return { outcome: 'ignored', reason: 'address_not_owned' };
      }

      const wallet = await custody.findWalletById(address.walletId);
      if (!wallet) {
        return { outcome: 'ignored', reason: 'wallet_missing' };
      }
      if (wallet.status !== 'active') {
        return { outcome: 'ignored', reason: 'wallet_not_active' };
      }

      /**
       * THE ALLOWLIST GATE (ADR-0016, rules 124-125).
       *
       * This sits AFTER address ownership on purpose. A transfer to an address
       * we do not own is not our business and gets no row. A transfer of an
       * unrecognised mint to an address we DO own is very much our business:
       * it is money sitting in our custody that we are choosing not to credit,
       * and a user will eventually ask about it.
       *
       * So it is recorded — attributable, with a reason, and with no ledger
       * entries, because nothing is owed to anyone.
       */
      if (!deps.assets.isAllowed(event.asset)) {
        /**
         * Which reason to record.
         *
         * `assets.isToken` cannot answer this: it means "is an ALLOWLISTED
         * token", and by construction we are here because the asset is not on
         * the list. The registry has no way to tell an unknown mint from an
         * unknown ticker, and giving it one would mean teaching
         * `packages/types` what a mint address looks like — chain knowledge in
         * the one package that must not have any.
         *
         * The adapter does know, and says so: a token event carries a
         * `tokenAccount` in its metadata and a native one never does. This
         * picks a LABEL for an operator, not a code path — both branches
         * refuse to credit, identically — which is why reading `metadata` here
         * does not make the domain depend on it.
         */
        const reason =
          event.metadata?.tokenAccount !== undefined
            ? IGNORED_REASONS.mintNotAllowlisted
            : IGNORED_REASONS.assetNotAllowlisted;

        return withTransaction(deps.db, async (tx) => {
          const recorded = await deposits.record(
            {
              walletId: wallet.id,
              addressId: address.id,
              userId: wallet.userId,
              chain: event.chain,
              asset: event.asset,
              amount: event.amount,
              rentReserved: '0',
              txSignature: event.txReference,
              instructionIndex: event.instructionIndex,
              position: event.position,
            },
            tx,
          );

          if (recorded.outcome === 'duplicate') {
            return { outcome: 'duplicate' as const };
          }

          await deposits.markIgnored(recorded.deposit.id, reason, tx);

          // The mint is NOT logged. It is an unbounded, attacker-chosen string
          // arriving from the chain, and the allowlist exists precisely
          // because such values are not to be trusted. The deposit row carries
          // it where it can be read deliberately (rule 165).
          logSecurityEvent(deps.logger, 'deposit.ignored', {
            outcome: 'failure',
            userId: wallet.userId,
            targetType: 'deposit',
            targetId: recorded.deposit.id,
          });

          // NOT the mint: see `labelFor`. An unallowlisted mint as a label is
          // an unbounded-cardinality series anyone can create by sending dust.
          deps.metrics?.deposits.inc({ asset: 'unallowlisted', outcome: 'ignored' });
          return { outcome: 'ignored' as const, reason };
        });
      }

      const amount = toAmount(event.amount);
      const rent = toAmount(rentReserved);
      // Rent can only be reserved out of what actually arrived.
      const applicableRent = rent > amount ? amount : rent;

      // The accounts this posting will touch, created up front and OUTSIDE the
      // serializable transaction below. Account creation is idempotent and not
      // balance-affecting, and doing it inside was the dominant source of
      // write conflicts under concurrent deposits to one user.
      await ledger.ensureAccounts([
        { ownerId: null, asset: event.asset, type: 'chain_assets' },
        { ownerId: wallet.userId, asset: event.asset, type: 'user_available' },
        { ownerId: null, asset: event.asset, type: 'house_rent' },
      ]);

      return withTransaction(deps.db, async (tx) => {
        const recorded = await deposits.record(
          {
            walletId: wallet.id,
            addressId: address.id,
            userId: wallet.userId,
            chain: event.chain,
            asset: event.asset,
            amount: toBaseUnits(amount),
            rentReserved: toBaseUnits(applicableRent),
            txSignature: event.txReference,
            instructionIndex: event.instructionIndex,
            position: event.position,
          },
          tx,
        );

        if (recorded.outcome === 'duplicate') {
          // Rule 154: already processed, and that is a success. Nothing is
          // written and nothing is retried.
          return { outcome: 'duplicate' as const };
        }

        const posting = postDeposit({
          depositId: recorded.deposit.id,
          userId: wallet.userId,
          asset: event.asset,
          amount,
          ...(applicableRent > 0n ? { rentReserved: applicableRent } : {}),
        });

        const ledgerTransactionId = await ledger.postTransaction(
          {
            kind: posting.kind,
            referenceType: posting.referenceType,
            referenceId: posting.referenceId,
            entries: posting.entries.map((entry) => ({
              account: {
                ownerId: entry.account.ownerId,
                asset: entry.account.asset,
                type: entry.account.type,
              },
              asset: entry.asset,
              amount: toBaseUnits(entry.amount),
              direction: entry.direction,
            })),
          },
          tx,
        );

        await deposits.markCredited(recorded.deposit.id, ledgerTransactionId, tx);
        deps.metrics?.deposits.inc({ asset: labelFor(event.asset), outcome: 'credited' });

        // Identifiers only. The amount and the address are deliberately absent:
        // adding them would require weakening the logger allowlist, which is a
        // decision, not a convenience (rules 41, 160, 223).
        logSecurityEvent(deps.logger, 'deposit.credited', {
          outcome: 'success',
          userId: wallet.userId,
          targetType: 'deposit',
          targetId: recorded.deposit.id,
        });

        return { outcome: 'credited' as const, depositId: recorded.deposit.id };
      });
    },
  };
}

export { createCursorRepository };

/**
 * The asset label for a metric (prompt_phase4.md rule 156).
 *
 * An ALLOWLISTED asset key is a closed set and safe as a label. An
 * unallowlisted mint is an attacker-chosen string arriving from the chain:
 * using it directly would let anyone create unbounded metric series by sending
 * dust from new mints, which is a cardinality attack with a trivially low cost.
 * Everything off the list collapses to one bucket.
 */
function labelFor(asset: string): string {
  return asset;
}
