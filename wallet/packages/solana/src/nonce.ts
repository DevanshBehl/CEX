import {
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { ChainError } from '@wallet/errors';
import type { SolanaRpc } from './rpc.js';
import { toPublicKey } from './rpc.js';

/**
 * Durable nonce accounts (ADR-0009).
 *
 * A transaction built on a durable nonce stays valid indefinitely until that
 * nonce advances, which is what makes signing latency safe and re-broadcast
 * unambiguous.
 *
 * The property that matters: **the nonce advancing exactly once is proof the
 * transaction landed exactly once.** With a recent blockhash, "did it land?"
 * has no answer once the hash expires — the transaction may be sitting in a
 * validator's queue about to be included. With a durable nonce, the answer is
 * one account read.
 */

export interface NonceState {
  readonly address: string;
  /** The value a transaction must be built on to be valid. */
  readonly nonce: string;
  /** The account permitted to advance it. */
  readonly authority: string;
}

export interface NonceManager {
  /** The minimum balance a nonce account needs to exist, read from the chain. */
  getRentExemptMinimum(): Promise<string>;
  /** Read the current nonce. Returns null when the account does not exist. */
  readNonce(address: string): Promise<NonceState | null>;
  /**
   * Has the nonce moved on from the value a transaction was built on?
   *
   * This is the ambiguity-resolving question. Advanced means our transaction —
   * or a competing one on the same nonce — has landed, and the built
   * transaction can never land now.
   */
  hasAdvanced(address: string, builtOn: string): Promise<boolean>;
  /** Build the instructions that create a nonce account. */
  buildCreateTransaction(input: {
    payer: string;
    nonceAccount: string;
    authority: string;
    lamports: string;
  }): Promise<Transaction>;
}

export function createNonceManager(rpc: SolanaRpc): NonceManager {
  return {
    async getRentExemptMinimum() {
      const lamports = await rpc.call('getMinimumBalanceForRentExemption(nonce)', (connection) =>
        connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH),
      );
      return BigInt(lamports).toString();
    },

    async readNonce(address) {
      const info = await rpc.call('getAccountInfo(nonce)', (connection) =>
        connection.getAccountInfo(toPublicKey(address), 'finalized'),
      );
      if (!info) return null;

      try {
        const account = NonceAccount.fromAccountData(info.data);
        return {
          address,
          nonce: account.nonce,
          authority: account.authorizedPubkey.toBase58(),
        };
      } catch (cause) {
        // The address exists but is not a nonce account. Treating this as
        // "absent" would hide a configuration error.
        throw new ChainError('Account is not a durable nonce account', cause);
      }
    },

    async hasAdvanced(address, builtOn) {
      const state = await this.readNonce(address);
      if (state === null) {
        // The account is gone. A transaction built on it can never land, which
        // is the same practical answer as "advanced".
        return true;
      }
      return state.nonce !== builtOn;
    },

    async buildCreateTransaction(input) {
      const recent = await rpc.call('getLatestBlockhash', (connection) =>
        connection.getLatestBlockhash('finalized'),
      );

      // Creating a nonce account is itself an ordinary transaction and may use
      // a recent blockhash: it is short-lived, retryable, and moves no user
      // funds. The durable nonce is for the withdrawals built ON this account.
      const transaction = new Transaction({
        feePayer: toPublicKey(input.payer),
        blockhash: recent.blockhash,
        lastValidBlockHeight: recent.lastValidBlockHeight,
      });

      transaction.add(
        SystemProgram.createAccount({
          fromPubkey: toPublicKey(input.payer),
          newAccountPubkey: toPublicKey(input.nonceAccount),
          lamports: Number(input.lamports),
          space: NONCE_ACCOUNT_LENGTH,
          programId: SystemProgram.programId,
        }),
        SystemProgram.nonceInitialize({
          noncePubkey: toPublicKey(input.nonceAccount),
          authorizedPubkey: toPublicKey(input.authority),
        }),
      );

      return transaction;
    },
  };
}

/** A fresh keypair for a nonce account. Public half only leaves this function. */
export function generateNonceAccountAddress(): { address: string; keypair: Keypair } {
  const keypair = Keypair.generate();
  return { address: keypair.publicKey.toBase58(), keypair };
}

export { NONCE_ACCOUNT_LENGTH, PublicKey };

/**
 * The outcome of creating one durable nonce account on chain.
 *
 * `nonce` is read back from the initialised account rather than assumed: the
 * value a withdrawal must be built on is whatever the chain says it is.
 */
export interface NonceProvisionResult {
  readonly address: string;
  readonly nonce: string;
  readonly lamports: string;
  readonly transactionSignature: string;
}

/**
 * Create and initialise one durable nonce account, paid for by `payer`.
 *
 * WHY THIS LIVES HERE AND NOT IN A SCRIPT
 *
 * Creating a nonce account needs two signatures: the payer's, which is custody
 * key material and therefore only ever produced by the signer behind the MPC
 * boundary, and the new account's own, which is ephemeral and exists purely to
 * prove the address was not squatted. Only `packages/solana` may touch the
 * chain SDK (prompt_phase2.md rules 98-101), so the assembly belongs here and
 * the caller supplies `signPayer` without learning what signs.
 *
 * The ephemeral keypair never leaves this function and is not custody material:
 * once `nonceInitialize` names `authority`, only the authority can advance or
 * withdraw from the account.
 */
export async function provisionNonceAccount(input: {
  readonly nonces: NonceManager;
  readonly broadcast: (signedTransaction: Uint8Array) => Promise<{ signature: string }>;
  readonly payer: string;
  readonly authority: string;
  readonly signPayer: (message: Uint8Array) => Promise<Uint8Array>;
  /** Polled until the account reports a nonce. Defaults to 60 x 1s. */
  readonly confirmAttempts?: number;
  readonly confirmIntervalMs?: number;
}): Promise<NonceProvisionResult> {
  const lamports = await input.nonces.getRentExemptMinimum();
  const { address, keypair } = generateNonceAccountAddress();

  const transaction = await input.nonces.buildCreateTransaction({
    payer: input.payer,
    nonceAccount: address,
    authority: input.authority,
    lamports,
  });

  // The new account signs for itself; the payer signs through the MPC
  // boundary. Both sign the identical message — `serializeMessage` does not
  // depend on the signatures already attached.
  transaction.partialSign(keypair);
  const signature = await input.signPayer(new Uint8Array(transaction.serializeMessage()));
  if (signature.length !== 64) {
    throw new ChainError(`Signer returned ${signature.length} bytes, expected 64`);
  }
  transaction.addSignature(toPublicKey(input.payer), Buffer.from(signature));

  const { signature: transactionSignature } = await input.broadcast(
    new Uint8Array(transaction.serialize({ requireAllSignatures: true, verifySignatures: true })),
  );

  // Read the nonce back rather than trusting the broadcast. Until the account
  // is finalised there is no nonce to build a withdrawal on, and recording one
  // that does not exist yet would hand the pool an unusable lease.
  const attempts = input.confirmAttempts ?? 60;
  const intervalMs = input.confirmIntervalMs ?? 1_000;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await input.nonces.readNonce(address);
    if (state !== null) {
      return { address, nonce: state.nonce, lamports, transactionSignature };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new ChainError(
    `Nonce account ${address} did not appear on chain after ${String(attempts)} attempts`,
  );
}
