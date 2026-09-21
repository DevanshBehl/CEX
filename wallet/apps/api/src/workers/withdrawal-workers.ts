import { randomUUID, type KeyObject } from 'node:crypto';
import { signAuthorization, type Signer } from '@wallet/blockchain';
import {
  createLedgerRepository,
  createNonceAccountRepository,
  createSigningRequestRepository,
  createWithdrawalRepository,
  withTransaction,
  type PrismaClient,
  type WithdrawalRecord,
} from '@wallet/db';
import { postWithdrawalSettlement, toAmount, toBaseUnits } from '@wallet/ledger';
import { logSecurityEvent, runWithContext, type Logger } from '@wallet/logger';
import { isTerminal, parseLedgerAssetKey } from '@wallet/types';
import type { DeadLetterQueue, JobQueue } from '../observability/dead-letter.js';
import type { WalletMetrics } from '../observability/metrics.js';
import type { NonceManager, WithdrawalBroadcaster } from '@wallet/solana';
import {
  attachSignatures,
  buildTokenTransferTransaction,
  buildWithdrawalTransaction,
  deriveAssociatedTokenAddress,
  type UnsignedWithdrawal,
} from '@wallet/solana';
import type { AssetRegistry } from '@wallet/types';
import { releaseLock } from '../services/withdrawal.service.js';

export interface RetryBudgets {
  readonly sign: number;
  readonly broadcast: number;
  readonly expiry: number;
}

export interface WithdrawalWorkerDeps {
  readonly db: PrismaClient;
  readonly signer: Signer & { readonly kind?: string };
  readonly nonces: NonceManager;
  readonly broadcaster: WithdrawalBroadcaster;
  readonly logger: Logger;
  readonly chain: string;
  /**
   * The house address: the nonce authority, and the fee payer for every
   * withdrawal.
   *
   * Under the omnibus model it is also the SOURCE of the funds. Under
   * segregated custody (ADR-0020) it is not — see `segregated` below.
   */
  readonly treasuryAddress: string;
  /** The house key, which signs as fee payer and nonce authority. */
  readonly keyRefId: string;
  /**
   * Segregated custody (ADR-0020). Absent means the omnibus model.
   *
   * When present, a withdrawal is paid from the USER's own address and signed
   * by the user's own threshold key, while the house still pays the fee — so
   * the transaction has two signers and needs two signing rounds.
   */
  readonly segregated?: SegregatedSource | undefined;
  readonly budgets: RetryBudgets;
  readonly batchSize: number;
  /**
   * The approval authority's key, used to sign the proof the signer verifies.
   *
   * Absent in development: the signing service then warns on every request that
   * it is signing without a verified authorization (ADR-0015).
   */
  readonly approvalKey?: KeyObject | undefined;
  /**
   * Where a job goes when it has exhausted its budget (rule 153).
   *
   * Optional so a test harness need not supply one; when absent, the withdrawal
   * still transitions to FAILED and is still logged — the queue adds an
   * operator surface, it is not part of the correctness of giving up.
   */
  readonly deadLetters?: DeadLetterQueue | undefined;
  readonly metrics?: WalletMetrics | undefined;
  /** The allowlist, for deciding whether an asset is a token (ADR-0016). */
  readonly assets: AssetRegistry;
  /**
   * Chain reads the token path needs.
   *
   * Named `chainReader`, not `chain` — that name is already the chain ID on
   * this interface, and a field that is sometimes a string and sometimes an
   * object is how a rename goes wrong quietly.
   */
  readonly chainReader: { accountExists(address: string): Promise<boolean> };
}

/**
 * Where a user's funds actually live, under segregation.
 *
 * An interface rather than a repository call so the worker keeps its single
 * dependency on persistence (`deps.db`) and so a test can answer it without a
 * database.
 */
export interface SegregatedSource {
  /**
   * The user's own address and the key that controls it.
   *
   * Both, together, because they must agree: signing with a key that does not
   * control the source address produces a transaction the network rejects
   * after a nonce has already been consumed.
   */
  resolve(userId: string): Promise<{ readonly address: string; readonly keyRef: string }>;
}

export interface WithdrawalWorkers {
  /**
   * Re-run the lifecycle for one withdrawal, for the dead-letter retry surface
   * (master-prompt rule 173, prompt_phase4.md rules 153-154).
   *
   * A TERMINAL withdrawal is NOT resurrected. When a withdrawal exhausts its
   * retry budget it transitions to FAILED and its locked funds are released
   * back to the user (ADR-0012) — so "retrying" it would re-lock money the
   * user has already been given back, and spend against an authorisation that
   * was abandoned. The correct recovery is a new withdrawal request, made by
   * the user, with a fresh risk decision.
   *
   * Throws in that case so the retry surface reports `failed` and the operator
   * learns why, rather than silently doing nothing and appearing to succeed.
   */
  retry(withdrawalId: string): Promise<void>;
  runSigningCycle(): Promise<number>;
  runBroadcastCycle(): Promise<number>;
  runConfirmationCycle(): Promise<number>;
  runAllCycles(): Promise<{ signed: number; broadcast: number; confirmed: number }>;
}

/**
 * The three workers that carry a withdrawal from locked funds to settlement.
 *
 * Each one re-reads and re-validates state inside the transaction that claims
 * the job (prompt_phase3.md rules 104-105). A queue payload is a hint, never a
 * fact — a stale message must not resurrect a withdrawal that was cancelled
 * while it sat in the queue.
 */
export function createWithdrawalWorkers(deps: WithdrawalWorkerDeps): WithdrawalWorkers {
  const withdrawals = createWithdrawalRepository(deps.db);
  const nonces = createNonceAccountRepository(deps.db);
  const signingRequests = createSigningRequestRepository(deps.db);

  /** A short, operator-readable cause. Never a full driver message. */
  function describeFailure(error: unknown): string {
    if (!(error instanceof Error)) return 'unknown';
    const message = error.message.replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 160);
    return `${error.name}: ${message}`;
  }

  /** Retry budget exhausted: terminal, lock released, visible to an operator. */
  async function giveUp(
    withdrawal: WithdrawalRecord,
    from: WithdrawalRecord['status'],
    reason: string,
    correlationId: string,
  ): Promise<void> {
    // Released BEFORE the terminal transition, so a crash in between leaves the
    // withdrawal retryable rather than terminal-with-funds-still-locked. The
    // release is idempotent in effect: a second attempt finds nothing locked.
    await releaseLock(deps.db, withdrawal);
    await nonces.release(withdrawal.id);

    await withdrawals.transition({
      withdrawalId: withdrawal.id,
      from,
      to: 'FAILED',
      reason,
      correlationId,
      patch: { failureReason: reason },
    });

    logSecurityEvent(deps.logger, 'withdrawal.failed', {
      outcome: 'failure',
      userId: withdrawal.userId,
      targetType: 'withdrawal',
      targetId: withdrawal.id,
      reason,
    });

    deps.metrics?.failures.inc({ stage: queueFor(from) });
    deps.metrics?.withdrawals.inc({ asset: withdrawal.asset, state: 'FAILED' });

    /**
     * Parked for an operator even though the withdrawal is now terminal and
     * the user has their funds back.
     *
     * The value is visibility, not resurrection: a run of budget exhaustions
     * on one queue is how an RPC outage or a dry nonce pool announces itself,
     * and `retry` deliberately refuses a terminal withdrawal. The idempotency
     * key is the withdrawal id, which is what every downstream operation is
     * already keyed on.
     */
    deps.deadLetters?.record({
      queue: queueFor(from),
      reference: withdrawal.id,
      idempotencyKey: `withdrawal:${withdrawal.id}`,
      attempts: deps.budgets.sign,
      errorName: reason,
      correlationId,
    });
  }

  /**
   * Build a token withdrawal.
   *
   * Two things the native path does not have to think about:
   *
   * 1. **The destination's token account may not exist.** Read from the chain
   *    rather than assumed — creating one that exists fails the transaction,
   *    and not creating one that is missing fails it too. Its rent is a house
   *    expense (`postTokenAccountRent`), never charged to the user.
   *
   * 2. **The treasury pays the fee in SOL.** A token transfer cannot pay its
   *    own fee (rule 119). The treasury holds SOL, so for a WITHDRAWAL the fee
   *    funding step a sweep needs does not apply — the fee payer already has
   *    a balance. That asymmetry is why sweeps are the harder half.
   */
  async function buildTokenWithdrawal(
    withdrawal: WithdrawalRecord,
    source: string,
    nonceAccount: string,
    nonce: string,
  ): Promise<UnsignedWithdrawal> {
    /*
     * THE BARE MINT. `withdrawal.asset` is a LEDGER key, not an address.
     *
     * Storage speaks `localnet:EPjF…Dt1v` (ADR-0021) and the chain speaks
     * `EPjF…Dt1v`. Everything above this line is right to use the qualified
     * key — `assets.isToken`, the ledger accounts, the risk policy all key on
     * it — and everything below it is an address the runtime will parse.
     *
     * Passed unqualified, `PublicKey` rejects the colon and signing failed
     * with `ChainError: Invalid Solana address`, every time, for every token.
     * The cluster dimension arrived after token support and this branch was
     * never revisited; nothing caught it because no test sent a token past
     * the request stage.
     */
    const mint = parseLedgerAssetKey(withdrawal.asset).asset;

    const sourceTokenAccount = deriveAssociatedTokenAddress(source, mint);
    const destinationTokenAccount = deriveAssociatedTokenAddress(withdrawal.destination, mint);

    const exists = await deps.chainReader.accountExists(destinationTokenAccount);

    const built = buildTokenTransferTransaction({
      owner: source,
      ownerTokenAccount: sourceTokenAccount,
      // The house pays the fee and any ATA rent even when the tokens are the
      // user's. A segregated address holds no SOL of its own, so without this
      // a token-only balance could never be withdrawn (ADR-0020 §3).
      feePayer: deps.treasuryAddress,
      destinationOwner: withdrawal.destination,
      mint,
      amount: withdrawal.amount,
      nonceAccount,
      nonceAuthority: deps.treasuryAddress,
      nonce,
      createDestinationAccount: !exists,
    });

    return {
      message: built.message,
      transaction: built.transaction,
      nonce: built.nonce,
      signers: built.signers,
    };
  }

  /** Which queue a give-up belongs to, for the operator's view. */
  function queueFor(status: WithdrawalRecord['status']): JobQueue {
    if (status === 'BROADCAST_FAILED') return 'withdrawal_broadcast';
    if (status === 'EXPIRED') return 'withdrawal_expiry';
    return 'withdrawal_sign';
  }

  // -------------------------------------------------------------------------
  // 1. Sign
  // -------------------------------------------------------------------------
  async function signOne(correlationId: string): Promise<boolean> {
    // Only APPROVED work reaches the signer, and FUNDS_LOCKED is the only door
    // (master-prompt rule 138, rule 103).
    const claimed = await withTransaction(deps.db, async (tx) =>
      createWithdrawalRepository(tx).claimNext(
        'FUNDS_LOCKED',
        'SIGNING',
        correlationId,
        deps.chain,
        tx,
      ),
    );
    if (!claimed) return false;

    logSecurityEvent(deps.logger, 'withdrawal.signing_started', {
      outcome: 'success',
      userId: claimed.userId,
      targetType: 'withdrawal',
      targetId: claimed.id,
    });

    try {
      const lease = await withTransaction(deps.db, async (tx) =>
        createNonceAccountRepository(tx).lease(deps.chain, claimed.id, tx),
      );

      if (!lease) {
        // A dry pool is an operational condition, not a failure. The withdrawal
        // goes back to FUNDS_LOCKED and waits; nothing is lost.
        logSecurityEvent(deps.logger, 'nonce.pool_exhausted', { outcome: 'failure' });
        await withdrawals.transition({
          withdrawalId: claimed.id,
          from: 'SIGNING',
          to: 'SIGN_FAILED',
          reason: 'nonce_pool_exhausted',
          correlationId,
        });
        return true;
      }

      const state = await deps.nonces.readNonce(lease.address);
      if (!state) throw new Error(`nonce account ${lease.id} has no on-chain state`);

      /**
       * Native or token, decided by the asset (ADR-0016).
       *
       * The state machine, the nonce lease, the signing request, the
       * idempotency key and the settlement posting are all identical either
       * way — only the bytes differ. prompt_phase4.md rule 126 says a token
       * withdrawal that cannot reuse the withdrawal machine means the machine
       * was chain-specific, and that would be the defect. This is the one
       * place the two paths diverge.
       */
      /*
       * WHERE THE MONEY LEAVES FROM (ADR-0020 §3).
       *
       * Under segregation it is the user's own address, controlled by the
       * user's own threshold key — so a compromise of three participants for
       * one user yields one user's funds, not the platform's. The house
       * remains the fee payer and the nonce authority, which is what keeps the
       * experience gasless and what makes a token-only balance spendable.
       *
       * Without segregation both roles are the treasury and this resolves to
       * exactly the previous behaviour.
       */
      const source = deps.segregated
        ? await deps.segregated.resolve(claimed.userId)
        : { address: deps.treasuryAddress, keyRef: deps.keyRefId };

      const unsigned = deps.assets.isToken(claimed.asset)
        ? await buildTokenWithdrawal(claimed, source.address, lease.address, state.nonce)
        : buildWithdrawalTransaction({
            from: source.address,
            feePayer: deps.treasuryAddress,
            to: claimed.destination,
            lamports: claimed.amount,
            nonceAccount: lease.address,
            nonceAuthority: deps.treasuryAddress,
            nonce: state.nonce,
          });

      /**
       * The idempotency key is (withdrawal, nonce), not the withdrawal alone.
       *
       * THE BUG THIS FIXES, which only the real signer surfaced:
       *
       * After EXPIRED the withdrawal leases a FRESH nonce and rebuilds, so the
       * transaction bytes change. Keyed on the withdrawal id alone, the second
       * signing request carried the same id over different bytes — and
       * `MockSigner` cheerfully returned its cached signature, which is a
       * signature over the OLD transaction. It would have been attached to the
       * new one and broadcast, and would have failed on-chain as an invalid
       * signature. The fake broadcaster does not verify signatures, so every
       * test passed.
       *
       * `services/mpc` refuses it outright: reusing an id with new bytes is an
       * attempt to spend one authorisation twice (ADR-0013).
       *
       * Keying on the nonce is also exactly the property FROST needs in 4b —
       * one signing round per nonce, never two (ADR-0015).
       */
      const requestId = `withdrawal:${claimed.id}:${state.nonce}`;
      const unsignedAuthorization = {
        approvedBy: 'risk-engine',
        approvedAt: claimed.createdAt.toISOString(),
        policyVersion: '1',
        reference: claimed.id,
        /**
         * Ordinary user withdrawals are served from the working float
         * (ADR-0018). One that hot cannot cover is an operational event
         * handled before a withdrawal reaches signing, not a tier the worker
         * silently escalates to — escalating here would make routine traffic
         * reach into a tier whose whole value is being rarely touched.
         */
        tier: 'hot' as const,
      };

      /**
       * Sign the proof, binding it to THESE bytes.
       *
       * Without the binding, a genuine approval for one withdrawal could be
       * replayed onto another — which is the attack the payload hash in
       * `authorizationMessage` exists to stop (ADR-0015).
       */
      const authorization =
        deps.approvalKey === undefined
          ? unsignedAuthorization
          : signAuthorization(unsignedAuthorization, unsigned.message, deps.approvalKey);

      /*
       * ONE ROUND PER SIGNER.
       *
       * A segregated withdrawal is signed twice: by the house, which pays the
       * fee and authorises the nonce, and by the user, whose funds move. The
       * key that signs for an address is the key that controls it — mixing
       * them up produces a transaction the network rejects only after the
       * nonce has been spent, which costs a retry with a fresh nonce.
       *
       * The request ids must DIFFER between the two: the signing service is
       * idempotent on the request id, so reusing one would hand back the first
       * signature for the second key. The house round keeps the bare id so an
       * omnibus deployment's in-flight requests are unaffected.
       */
      const rounds = unsigned.signers.map((address) =>
        address === source.address && source.address !== deps.treasuryAddress
          ? { address, keyRef: source.keyRef, requestId: `${requestId}:source` }
          : { address, keyRef: deps.keyRefId, requestId },
      );

      const signatures: Array<{ signer: string; signature: Uint8Array }> = [];

      for (const round of rounds) {
        const alreadyOpen = await signingRequests.findByRequestId(round.requestId);
        if (!alreadyOpen) {
          await signingRequests.open({
            withdrawalId: claimed.id,
            requestId: round.requestId,
            keyRef: round.keyRef,
            signerKind: deps.signer.kind ?? 'unknown',
            authorization: { ...authorization },
          });
        }

        const result = await deps.signer.sign({
          requestId: round.requestId,
          keyRef: { id: round.keyRef },
          payload: unsigned.message,
          authorization,
        });

        if (result.signature.length !== 64) {
          throw new Error(`signer returned ${result.signature.length} bytes, expected 64`);
        }

        signatures.push({ signer: round.address, signature: result.signature });
      }

      const signed = attachSignatures(unsigned, signatures);
      for (const round of rounds) {
        await signingRequests.succeed(round.requestId);
      }

      /**
       * The signed bytes are persisted with the transition.
       *
       * Re-broadcast uses THESE bytes and never signs new ones
       * (rules 140-143). Losing them would leave a transaction that may still
       * land and no way to reproduce it.
       */
      await withdrawals.transition({
        withdrawalId: claimed.id,
        from: 'SIGNING',
        to: 'SIGNED',
        correlationId,
        patch: {
          signedTransaction: signed,
          nonceAccountId: lease.id,
          nonceValue: state.nonce,
        },
      });

      logSecurityEvent(deps.logger, 'withdrawal.signed', {
        outcome: 'success',
        userId: claimed.userId,
        targetType: 'withdrawal',
        targetId: claimed.id,
      });
      return true;
    } catch (error) {
      /**
       * The reason is operator-facing and must be diagnosable — an error class
       * name alone ("Error") tells whoever is on call nothing.
       *
       * Truncated, because a driver message can be long and can carry an RPC
       * endpoint with an API key in it. This is written to the transition
       * history, which is append-only, so it is worth being deliberate about.
       */
      const reason = describeFailure(error);
      // The request id includes the nonce, which may not have been leased yet
      // if the failure happened before that. Failing by withdrawal is the
      // reliable shape here.
      await signingRequests.failForWithdrawal(claimed.id, reason);
      await withdrawals.transition({
        withdrawalId: claimed.id,
        from: 'SIGNING',
        to: 'SIGN_FAILED',
        reason,
        correlationId,
        incrementAttempt: 'sign',
      });
      logSecurityEvent(deps.logger, 'withdrawal.sign_failed', {
        outcome: 'failure',
        userId: claimed.userId,
        targetType: 'withdrawal',
        targetId: claimed.id,
        reason,
      });
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // 2. Broadcast
  // -------------------------------------------------------------------------
  async function broadcastOne(correlationId: string): Promise<boolean> {
    const claimed = await withTransaction(deps.db, async (tx) =>
      createWithdrawalRepository(tx).claimNext(
        'SIGNED',
        'BROADCAST',
        correlationId,
        deps.chain,
        tx,
      ),
    );
    if (!claimed) return false;

    if (!claimed.signedTransaction) {
      await withdrawals.transition({
        withdrawalId: claimed.id,
        from: 'BROADCAST',
        to: 'BROADCAST_FAILED',
        reason: 'missing_signed_transaction',
        correlationId,
        incrementAttempt: 'broadcast',
      });
      return true;
    }

    const outcome = await deps.broadcaster.broadcast(claimed.signedTransaction);

    if (outcome.kind === 'submitted') {
      /**
       * Persist the signature BEFORE awaiting confirmation
       * (master-prompt rule 141, rules 135-136).
       *
       * A crash between broadcast and persistence leaves a transaction in
       * flight that this system cannot recognise on restart and cannot safely
       * re-sign — the ambiguous broadcast in its worst form.
       *
       * The withdrawal is ALREADY in BROADCAST at this point, so even a crash
       * here leaves it recoverable: the confirmation worker finds it and the
       * nonce answers whether it landed.
       */
      await deps.db.withdrawal.update({
        where: { id: claimed.id },
        data: { txSignature: outcome.signature },
      });

      logSecurityEvent(deps.logger, 'withdrawal.broadcast', {
        outcome: 'success',
        userId: claimed.userId,
        targetType: 'withdrawal',
        targetId: claimed.id,
      });
      return true;
    }

    if (outcome.kind === 'nonce_advanced') {
      // These exact bytes can never land now. Recoverable, and PROVABLY so —
      // which is the difference from a dead blockhash (ADR-0009).
      await withdrawals.transition({
        withdrawalId: claimed.id,
        from: 'BROADCAST',
        to: 'EXPIRED',
        reason: 'nonce_advanced',
        correlationId,
        incrementAttempt: 'expiry',
      });
      logSecurityEvent(deps.logger, 'withdrawal.expired', {
        outcome: 'failure',
        userId: claimed.userId,
        targetType: 'withdrawal',
        targetId: claimed.id,
        reason: 'nonce_advanced',
      });
      return true;
    }

    await withdrawals.transition({
      withdrawalId: claimed.id,
      from: 'BROADCAST',
      to: 'BROADCAST_FAILED',
      reason: outcome.reason,
      correlationId,
      incrementAttempt: 'broadcast',
    });
    logSecurityEvent(deps.logger, 'withdrawal.broadcast_failed', {
      outcome: 'failure',
      userId: claimed.userId,
      targetType: 'withdrawal',
      targetId: claimed.id,
      reason: outcome.reason,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // 3. Confirm and settle
  // -------------------------------------------------------------------------
  async function confirmOne(withdrawal: WithdrawalRecord, correlationId: string): Promise<void> {
    if (!withdrawal.txSignature) {
      // Broadcast said submitted but the signature never landed in the row.
      // The nonce is the tiebreaker, not a guess.
      await resolveAmbiguity(withdrawal, correlationId);
      return;
    }

    const status = await deps.broadcaster.getFinalizedStatus(withdrawal.txSignature);

    if (status === 'pending') {
      await resolveAmbiguity(withdrawal, correlationId);
      return;
    }

    if (status === 'failed') {
      await withdrawals.transition({
        withdrawalId: withdrawal.id,
        from: 'BROADCAST',
        to: 'BROADCAST_FAILED',
        reason: 'transaction_failed_on_chain',
        correlationId,
        incrementAttempt: 'broadcast',
      });
      return;
    }

    const confirmed = await withdrawals.transition({
      withdrawalId: withdrawal.id,
      from: 'BROADCAST',
      to: 'CONFIRMED',
      correlationId,
    });
    if (!confirmed) return;

    const fee = await deps.broadcaster.getPaidFee(withdrawal.txSignature);
    await settle(confirmed, fee, correlationId);
  }

  /**
   * Broadcast, not yet confirmed: has it landed?
   *
   * With a durable nonce this has an ANSWER. If the nonce still holds the value
   * the transaction was built on, the transaction has not landed and the same
   * bytes are still valid — re-broadcast them. If it has advanced, either our
   * transaction landed (the confirmation check will see it) or a competing one
   * won the nonce, and ours never can.
   *
   * Never re-sign here. A re-sign without proof the previous attempt is dead is
   * the double-spend (rules 142-143).
   */
  async function resolveAmbiguity(
    withdrawal: WithdrawalRecord,
    correlationId: string,
  ): Promise<void> {
    if (!withdrawal.nonceAccountId || !withdrawal.nonceValue) return;

    const lease = await nonces.findById(withdrawal.nonceAccountId);
    if (!lease) return;

    const advanced = await deps.nonces.hasAdvanced(lease.address, withdrawal.nonceValue);

    if (!advanced) {
      // Still valid. Re-broadcast the IDENTICAL bytes — same signature, which
      // the network deduplicates if it is already there.
      if (withdrawal.signedTransaction) {
        await deps.broadcaster.broadcast(withdrawal.signedTransaction);
        logSecurityEvent(deps.logger, 'withdrawal.rebroadcast', {
          outcome: 'success',
          userId: withdrawal.userId,
          targetType: 'withdrawal',
          targetId: withdrawal.id,
        });
      }
      return;
    }

    // Advanced but our signature is not confirmed: a competing transaction won
    // the nonce. Ours can never land, so a fresh nonce and a new signature are
    // safe — and provably so.
    await withdrawals.transition({
      withdrawalId: withdrawal.id,
      from: 'BROADCAST',
      to: 'EXPIRED',
      reason: 'nonce_advanced_without_landing',
      correlationId,
      incrementAttempt: 'expiry',
    });
  }

  async function settle(
    withdrawal: WithdrawalRecord,
    fee: string | null,
    correlationId: string,
  ): Promise<void> {
    const amount = toAmount(withdrawal.amount);
    const networkFee = fee === null ? 0n : toAmount(fee);

    /*
     * The fee is paid in SOL whatever was withdrawn (ADR-0016).
     *
     * For a SOL withdrawal this is the same key and the accounts collapse to
     * the four they always were. For a token withdrawal it is a different
     * asset entirely, and the house's fee accounts must exist under the NATIVE
     * key — not under the mint, which is where a lamport fee would otherwise
     * be posted.
     */
    const feeAsset = deps.assets.nativeKey;

    await createLedgerRepository(deps.db).ensureAccounts([
      { ownerId: withdrawal.userId, asset: withdrawal.asset, type: 'user_custody_locked' },
      // The funds leave the USER's segregated address (ADR-0020)...
      { ownerId: withdrawal.userId, asset: withdrawal.asset, type: 'chain_assets' },
      // ...and the fee leaves the HOUSE's wallet, in the native asset. Two
      // different addresses and, for a token, two different assets — which is
      // why all of these accounts are needed for one settlement.
      { ownerId: null, asset: withdrawal.asset, type: 'chain_assets' },
      { ownerId: null, asset: feeAsset, type: 'chain_assets' },
      { ownerId: null, asset: feeAsset, type: 'house_fees' },
    ]);

    const posting = postWithdrawalSettlement({
      withdrawalId: withdrawal.id,
      userId: withdrawal.userId,
      asset: withdrawal.asset,
      feeAsset,
      amount,
      ...(networkFee > 0n ? { networkFee } : {}),
    });

    await withTransaction(deps.db, async (tx) => {
      const ledgerTransactionId = await createLedgerRepository(tx).postTransaction(
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

      await createWithdrawalRepository(tx).transition(
        {
          withdrawalId: withdrawal.id,
          from: 'CONFIRMED',
          to: 'SETTLED',
          correlationId,
          patch: {
            settleLedgerTransactionId: ledgerTransactionId,
            settledAt: new Date(),
            ...(fee !== null ? { networkFee: fee } : {}),
          },
        },
        tx,
      );

      await createNonceAccountRepository(tx).release(withdrawal.id, tx);
    });

    logSecurityEvent(deps.logger, 'withdrawal.settled', {
      outcome: 'success',
      userId: withdrawal.userId,
      targetType: 'withdrawal',
      targetId: withdrawal.id,
    });
  }

  // -------------------------------------------------------------------------
  // Retry edges (ADR-0012)
  // -------------------------------------------------------------------------
  async function processRetries(correlationId: string): Promise<void> {
    const edges = [
      { status: 'SIGN_FAILED' as const, budget: deps.budgets.sign, attempts: 'signAttempts' },
      {
        status: 'BROADCAST_FAILED' as const,
        budget: deps.budgets.broadcast,
        attempts: 'broadcastAttempts',
      },
      { status: 'EXPIRED' as const, budget: deps.budgets.expiry, attempts: 'expiryAttempts' },
    ] as const;

    for (const edge of edges) {
      const stuck = await withdrawals.listByStatus(edge.status, deps.batchSize, deps.chain);
      for (const withdrawal of stuck) {
        const used = withdrawal[edge.attempts];

        if (used >= edge.budget) {
          await giveUp(withdrawal, edge.status, `${edge.status}_budget_exhausted`, correlationId);
          continue;
        }

        // An expired withdrawal needs a fresh nonce, so its lease is dropped
        // before it returns to the queue.
        if (edge.status === 'EXPIRED') await nonces.release(withdrawal.id);

        await withdrawals.transition({
          withdrawalId: withdrawal.id,
          from: edge.status,
          to: 'FUNDS_LOCKED',
          reason: 'retry',
          correlationId,
        });
      }
    }
  }

  return {
    async retry(withdrawalId) {
      const withdrawal = await withdrawals.findById(withdrawalId);
      if (!withdrawal) {
        throw new Error(`withdrawal ${withdrawalId} no longer exists`);
      }
      if (isTerminal(withdrawal.status)) {
        throw new Error(
          `withdrawal ${withdrawalId} is terminal (${withdrawal.status}); ` +
            'its funds were already released and it cannot be retried',
        );
      }

      // Nothing bespoke: the ordinary cycles claim by state, and this simply
      // runs them now instead of waiting for the next tick. A retry path that
      // did its own signing would be a second implementation of the thing
      // most worth having only one of.
      await this.runAllCycles();
    },

    async runSigningCycle() {
      const correlationId = randomUUID();
      return runWithContext({ correlationId, route: 'worker:signer' }, async () => {
        await processRetries(correlationId);
        let processed = 0;
        while (processed < deps.batchSize && (await signOne(correlationId))) processed += 1;
        return processed;
      });
    },

    async runBroadcastCycle() {
      const correlationId = randomUUID();
      return runWithContext({ correlationId, route: 'worker:broadcast' }, async () => {
        let processed = 0;
        while (processed < deps.batchSize && (await broadcastOne(correlationId))) processed += 1;
        return processed;
      });
    },

    async runConfirmationCycle() {
      const correlationId = randomUUID();
      return runWithContext({ correlationId, route: 'worker:confirm' }, async () => {
        const pending = await withdrawals.listByStatus('BROADCAST', deps.batchSize, deps.chain);
        for (const withdrawal of pending) await confirmOne(withdrawal, correlationId);
        return pending.length;
      });
    },

    async runAllCycles() {
      return {
        signed: await this.runSigningCycle(),
        broadcast: await this.runBroadcastCycle(),
        confirmed: await this.runConfirmationCycle(),
      };
    },
  };
}
