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
