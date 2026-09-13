import type {
  NonceManager,
  NonceState,
  WithdrawalBroadcaster,
  BroadcastOutcome,
} from '@wallet/solana';

/**
 * A nonce pool and a broadcaster the tests control completely.
 *
 * The behaviours under test — the ambiguous broadcast, recovery after a crash
 * between SIGNED and BROADCAST, a nonce advancing under us — are properties of
 * ORDERING and timing. Proving them needs the ability to stop the world at an
 * exact point and to make the chain answer a specific way. A real validator
 * cannot be asked to do that; the localnet suite covers what it can.
 */

export interface FakeNonceManager extends NonceManager {
  provision(address: string, nonce: string): void;
  /** Simulate a competing transaction winning the nonce. */
  advance(address: string): void;
  currentNonce(address: string): string | null;
}

export function createFakeNonceManager(): FakeNonceManager {
  const nonces = new Map<string, string>();
  let counter = 0;

  return {
    provision(address, nonce) {
      nonces.set(address, nonce);
    },

    advance(address) {
      counter += 1;
      // A base58 value, because the transaction builder parses it.
      nonces.set(address, `${'1'.repeat(10)}Advanced${counter}${'x'.repeat(10)}`);
    },

    currentNonce(address) {
      return nonces.get(address) ?? null;
    },

    async getRentExemptMinimum() {
      return '1447680';
    },

    async readNonce(address): Promise<NonceState | null> {
      const nonce = nonces.get(address);
      if (nonce === undefined) return null;
      return { address, nonce, authority: 'TreasuryAddress' };
    },

    async hasAdvanced(address, builtOn) {
      const current = nonces.get(address);
      if (current === undefined) return true;
      return current !== builtOn;
    },

    async buildCreateTransaction() {
      throw new Error('not used in tests');
    },
  };
}

export type BroadcastBehaviour =
  | 'submit'
  /** The RPC refuses it. */
  | 'reject'
  /** These bytes can never land: the nonce moved on. */
  | 'nonce_advanced'
  /**
   * Submitted, and the caller never learns the outcome — the ambiguous
   * broadcast. The signature is recorded but confirmation stays pending.
   */
  | 'ambiguous';

export interface FakeBroadcaster extends WithdrawalBroadcaster {
  setBehaviour(behaviour: BroadcastBehaviour): void;
  /** Mark a submitted signature as finalized. */
  finalize(signature: string): void;
  failOnChain(signature: string): void;
  setFee(signature: string, lamports: string): void;
  submissions(): readonly string[];
  /** Distinct byte-strings seen. A re-broadcast must NOT increase this. */
  distinctPayloads(): number;
  /**
   * The raw bytes of the last submission.
   *
   * Kept so a test can parse the transaction and assert what it actually says
   * — which account is debited, who pays the fee, how many signatures it
   * carries. Asserting on the ledger alone would pass for a transaction that
   * moves the wrong account's money.
   */
  lastRaw(): Uint8Array | null;
}

export function createFakeBroadcaster(): FakeBroadcaster {
  let behaviour: BroadcastBehaviour = 'submit';
  const submitted: string[] = [];
  const payloads = new Set<string>();
  const finalized = new Set<string>();
  const failed = new Set<string>();
  const fees = new Map<string, string>();
  let lastBytes: Uint8Array | null = null;
  let counter = 0;

  /**
   * The signature is derived from the BYTES, exactly as a real chain derives it
   * from the signature inside them. That is what makes re-broadcasting
   * identical bytes idempotent, and it is the property the recovery path rests
   * on — so the fake must reproduce it or the tests would prove nothing.
   */
  const signatureFor = (bytes: Uint8Array): string => {
    const key = Buffer.from(bytes).toString('base64');
    payloads.add(key);
    return `sig-${Buffer.from(key).toString('hex').slice(0, 16)}`;
  };

  return {
    setBehaviour(next) {
      behaviour = next;
    },

    finalize(signature) {
      finalized.add(signature);
    },

    failOnChain(signature) {
      failed.add(signature);
    },

    setFee(signature, lamports) {
      fees.set(signature, lamports);
    },

    submissions() {
      return submitted;
    },

    distinctPayloads() {
      return payloads.size;
    },

    lastRaw() {
      return lastBytes;
    },

    async broadcast(signedTransaction): Promise<BroadcastOutcome> {
      counter += 1;
      lastBytes = signedTransaction;
      const signature = signatureFor(signedTransaction);

      if (behaviour === 'reject') return { kind: 'rejected', reason: 'rpc_rejected' };
      if (behaviour === 'nonce_advanced') return { kind: 'nonce_advanced' };

      submitted.push(signature);
      // `ambiguous` submits but never finalizes, so the caller must resolve it
      // from the nonce rather than from the submission result.
      return { kind: 'submitted', signature };
    },

    async getFinalizedStatus(signature) {
      if (failed.has(signature)) return 'failed';
      return finalized.has(signature) ? 'final' : 'pending';
    },

    async getPaidFee(signature) {
      return fees.get(signature) ?? '5000';
    },
  };
}
