import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionExpiredNonceInvalidError,
} from '@solana/web3.js';
import { ChainError } from '@wallet/errors';
import type { SolanaRpc } from './rpc.js';
import { toPublicKey } from './rpc.js';

/**
 * Building, signing, and broadcasting a withdrawal
 * (prompt_phase3.md rules 134-145).
 */

export interface BuildWithdrawalInput {
  /** The account the funds LEAVE. Under segregation, the user's own address. */
  readonly from: string;
  /**
   * Who pays the network fee. Defaults to `from`.
   *
   * The house pays it for a user withdrawal (ADR-0020 §3), so a user needs no
   * SOL to move a token — which is also the only way a token-only balance is
   * spendable at all. When this differs from `from` the transaction has TWO
   * signers and needs two signatures before it can be broadcast.
   */
  readonly feePayer?: string | undefined;
  readonly to: string;
  /** Base units, as a decimal string. Never a number. */
  readonly lamports: string;
  readonly nonceAccount: string;
  readonly nonceAuthority: string;
  /** The nonce value the transaction is built on. Persisted as evidence. */
  readonly nonce: string;
}

export interface UnsignedWithdrawal {
  /** Exactly the bytes the signer must sign. It does not parse them. */
  readonly message: Uint8Array;
  /** Serialized for reconstruction once a signature exists. */
  readonly transaction: Transaction;
  readonly nonce: string;
  /**
   * Every address that must sign, in no particular order.
   *
   * Returned rather than inferred by the caller: the set depends on the fee
   * payer, on whether an ATA is being created, and on the instruction layout —
   * all of which live here. A caller that guessed would produce a transaction
   * the network rejects only after a nonce had been consumed.
   */
  readonly signers: readonly string[];
}

/**
 * Build a transfer on a durable nonce.
 *
 * `nonceAdvance` must be the FIRST instruction — the runtime requires it, and
 * it is what consumes the nonce and makes the transaction single-use. That
 * single-use property is what turns "did it land?" into a question with an
 * answer (ADR-0009).
 */
export function buildWithdrawalTransaction(input: BuildWithdrawalInput): UnsignedWithdrawal {
  const amount = BigInt(input.lamports);
  if (amount <= 0n) {
    throw new ChainError('Withdrawal amount must be positive');
  }
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    // @solana/web3.js takes lamports as a JS number. Above 2^53 the value it
    // encodes is not the value we asked for, and the difference is silent.
    throw new ChainError('Withdrawal amount exceeds the SDK precision ceiling');
  }

  const feePayer = input.feePayer ?? input.from;

  const transaction = new Transaction({
    // The fee payer is the first signer of the message, and is charged the fee
    // regardless of which account the transfer debits.
    feePayer: toPublicKey(feePayer),
    nonceInfo: {
      nonce: input.nonce,
      nonceInstruction: SystemProgram.nonceAdvance({
        noncePubkey: toPublicKey(input.nonceAccount),
        authorizedPubkey: toPublicKey(input.nonceAuthority),
      }),
    },
  });

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: toPublicKey(input.from),
      toPubkey: toPublicKey(input.to),
      lamports: Number(amount),
    }),
  );

  return {
    message: new Uint8Array(transaction.serializeMessage()),
    transaction,
    nonce: input.nonce,
    // The nonce authority signs too. It is the house in every current
    // deployment, and deduplication keeps that from being stated twice.
    signers: [...new Set([feePayer, input.from, input.nonceAuthority])],
  };
}

/**
 * Attach a signature produced elsewhere.
 *
 * The signer never sees a `Transaction` — it signs bytes (rule 133). This is
 * where the two meet, and it is deliberately the only place.
 */
export function attachSignature(
  unsigned: UnsignedWithdrawal,
  signer: string,
  signature: Uint8Array,
): Uint8Array {
  return attachSignatures(unsigned, [{ signer, signature }]);
}

export interface AttachedSignature {
  /** The address the signature belongs to, base58. */
  readonly signer: string;
  readonly signature: Uint8Array;
}

/**
 * Attach every signature a transaction needs, in one step.
 *
 * A segregated withdrawal has two signers — the house fee payer and the user's
 * own key (ADR-0020 §3) — produced by two separate signing rounds. They are
 * attached together because `Transaction.from` reparses the wire format, and
 * attaching one signature at a time would mean serializing a half-signed
 * transaction and hoping the round trip preserved the other signature.
 *
 * It does NOT check that every required signature is present: a partially
 * signed transaction is a legitimate intermediate state, and the check that
 * matters is the network's. What it does check is that no signature is offered
 * for an address the message does not list as a signer — that mistake produces
 * bytes that are refused at broadcast, long after a nonce has been spent.
 */
export function attachSignatures(
  unsigned: UnsignedWithdrawal,
  signatures: readonly AttachedSignature[],
): Uint8Array {
  const transaction = Transaction.from(
    unsigned.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );

  const expected = new Set(transaction.signatures.map((entry) => entry.publicKey.toBase58()));

  for (const { signer, signature } of signatures) {
    if (signature.length !== 64) {
      throw new ChainError(`Signature must be 64 bytes, received ${signature.length}`);
    }
    if (!expected.has(signer)) {
      throw new ChainError(`${signer} is not a signer of this transaction`);
    }
    transaction.addSignature(new PublicKey(signer), Buffer.from(signature));
  }

  return new Uint8Array(
    transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
}

export type BroadcastOutcome =
  | { readonly kind: 'submitted'; readonly signature: string }
  /** The RPC refused it. Distinct from EXPIRED — see rule 144. */
  | { readonly kind: 'rejected'; readonly reason: string }
  /** The nonce had already advanced. These bytes can never land. */
  | { readonly kind: 'nonce_advanced' };

export interface WithdrawalBroadcaster {
  /**
   * Submit signed bytes.
   *
   * Idempotent by construction: re-submitting identical bytes yields the same
   * signature, and the network deduplicates. That is what makes an ambiguous
   * broadcast recoverable without re-signing (rules 140-141).
   */
  broadcast(signedTransaction: Uint8Array): Promise<BroadcastOutcome>;
  /** Ask the chain whether a signature reached finality. */
  getFinalizedStatus(signature: string): Promise<'final' | 'pending' | 'failed'>;
  /** The fee actually paid, once the transaction is finalized. */
  getPaidFee(signature: string): Promise<string | null>;
}

export function createWithdrawalBroadcaster(rpc: SolanaRpc): WithdrawalBroadcaster {
  return {
    async broadcast(signedTransaction) {
      try {
        const signature = await rpc.call('sendRawTransaction', (connection) =>
          connection.sendRawTransaction(Buffer.from(signedTransaction), {
            // Preflight would reject a duplicate as "already processed", which
            // is exactly the case we want to treat as success.
            skipPreflight: true,
            maxRetries: 0,
          }),
        );
        return { kind: 'submitted', signature };
      } catch (error) {
        if (error instanceof TransactionExpiredNonceInvalidError) {
          return { kind: 'nonce_advanced' };
        }
        const message = error instanceof Error ? error.message : String(error);

        // The network has already seen these exact bytes. Not a failure: it is
        // the re-broadcast path working as designed.
        if (/already been processed|AlreadyProcessed/i.test(message)) {
          return { kind: 'submitted', signature: extractSignature(message) ?? '' };
        }
        if (/nonce/i.test(message) && /invalid|advanced/i.test(message)) {
          return { kind: 'nonce_advanced' };
        }
        return { kind: 'rejected', reason: classify(message) };
      }
    },

    async getFinalizedStatus(signature) {
      const statuses = await rpc.call('getSignatureStatuses(withdrawal)', (connection) =>
        connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      );
      const status = statuses.value[0];
      if (!status) return 'pending';
      if (status.err !== null) return 'failed';
      return status.confirmationStatus === 'finalized' ? 'final' : 'pending';
    },

    async getPaidFee(signature) {
      const transaction = await rpc.call('getTransaction(fee)', (connection) =>
        connection.getTransaction(signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        }),
      );
      const fee = transaction?.meta?.fee;
      return fee === undefined || fee === null ? null : BigInt(fee).toString();
    },
  };
}

/**
 * A stable category rather than the driver's message.
 *
 * The raw text may contain the RPC endpoint, which can carry an API key, and
 * it is not stable enough to branch on.
 */
function classify(message: string): string {
  if (/insufficient funds|InsufficientFunds/i.test(message)) return 'insufficient_chain_balance';
  if (/blockhash not found|BlockhashNotFound/i.test(message)) return 'blockhash_not_found';
  if (/429|rate/i.test(message)) return 'rate_limited';
  if (/timeout|ETIMEDOUT/i.test(message)) return 'timeout';
  return 'rpc_rejected';
}

function extractSignature(message: string): string | null {
  return /([1-9A-HJ-NP-Za-km-z]{80,90})/.exec(message)?.[1] ?? null;
}
