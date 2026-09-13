import { createHash, createHmac } from 'node:crypto';
import type {
  KeyProvisioner,
  KeyRef,
  ProvisionedKey,
  SignRequest,
  SignResult,
  Signer,
} from '../signer.js';

/**
 * A signer for development and tests. NOT CRYPTOGRAPHY.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THIS PRODUCES SIGNATURES THAT VERIFY AGAINST NOTHING.                   │
 * │  It is an HMAC shaped like an Ed25519 signature, and a chain will        │
 * │  reject it. It exists so the withdrawal lifecycle can be exercised       │
 * │  while the signer is completely controllable.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Why this comes before the real one (prompt_phase3.md rules 6-11):
 *
 * The retry, timeout, expiry, and ambiguous-broadcast paths are where
 * withdrawals actually go wrong, and they are nearly impossible to provoke
 * against real MPC. A mock can be told to fail, hang, or return the same
 * signature twice, on demand, inside a test. A mock that only ever succeeds
 * would test nothing a real signer would not have tested better — which is why
 * fault injection is the substantive part of this file (rules 127-128).
 *
 * Phase 4 replaces it with a Rust threshold implementation. **If that
 * replacement requires editing anything above the `Signer` interface, the
 * abstraction leaked and that leak is the bug** (master-prompt rule 102).
 */

export type MockFault =
  /** Reject the request, as a signer that cannot reach its participants would. */
  | 'fail'
  /** Never resolve, so the caller's timeout is what ends it. */
  | 'hang'
  /** Resolve after a delay longer than any sane deadline. */
  | 'timeout'
  /** Return bytes of the wrong length — a corrupted response. */
  | 'malformed'
  /**
   * Succeed, but on a SECOND signing round for the same requestId.
   *
   * The dangerous one. Under threshold signing a duplicate round is not merely
   * wasteful, it is a nonce-reuse hazard, and the idempotency contract in
   * `SignRequest.requestId` exists to prevent it. This fault makes the mock
   * break that contract so the caller's handling can be tested.
   */
  | 'duplicate_round';

export interface MockSignerOptions {
  /** Deterministic seed. The same seed and requestId always give the same bytes. */
  readonly seed?: string;
  /** Faults keyed by requestId, consumed on use. */
  readonly faults?: ReadonlyMap<string, MockFault>;
  readonly nodeEnv?: string;
  /** Injected so tests can assert the banner without capturing stdout. */
  readonly onBanner?: (message: string) => void;
}

export interface MockSigner extends Signer, KeyProvisioner {
  readonly kind: 'mock';
  /**
   * Queue a fault for a request.
   *
   * Matches by PREFIX, because a caller's request id is structured and a test
   * usually cannot know all of it in advance. The withdrawal worker keys on
   * `withdrawal:{id}:{nonce}`, and the nonce is leased inside the operation
   * being tested — so a test can only name `withdrawal:{id}`.
   */
  injectFault(requestIdPrefix: string, fault: MockFault): void;
  clearFaults(): void;
  /** How many distinct signing rounds ran. Proves idempotency held. */
  roundCount(): number;
  callCount(): number;
}

const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BYTES = 32;

export function createMockSigner(options: MockSignerOptions = {}): MockSigner {
  const nodeEnv = options.nodeEnv ?? 'development';

  /**
   * A HARD FAILURE at construction, not a warning (rule 125).
   *
   * A warning is a line in a log nobody reads. This makes it impossible to
   * start a production process that would sign with a mock — the process does
   * not come up, which is the only outcome anyone will notice.
   */
  if (nodeEnv === 'production') {
    throw new Error(
      'MockSigner must never run in production. It produces signatures that verify ' +
        'against nothing. Configure a real signer (prompt_phase3.md rule 125).',
    );
  }

  const seed = options.seed ?? 'mock-signer-development-seed';
  const faults = new Map(options.faults ?? []);
  const banner = options.onBanner;

  /** requestId -> result. Idempotency: the same id never signs twice. */
  const completed = new Map<string, SignResult>();
  let rounds = 0;
  let calls = 0;

  function announce(requestId: string): void {
    const message =
      `\n  ⚠  MOCK SIGNER — this signature is not real cryptography and will not ` +
      `verify on any chain. requestId=${requestId}\n`;
    if (banner) banner(message);
    else process.stderr.write(message);
  }

  function derive(keyRef: KeyRef, requestId: string, payload: Uint8Array): SignResult {
    const signature = createHmac('sha512', `${seed}:${keyRef.id}`)
      .update(requestId)
      .update(Buffer.from(payload))
      .digest()
      .subarray(0, SIGNATURE_BYTES);

    return {
      requestId,
      signature: new Uint8Array(signature),
      publicKey: publicKeyFor(keyRef),
    };
  }

  /**
   * base58, so a mock address is shaped like a Solana one.
   *
   * Hand-rolled because `@wallet/blockchain` is chain-independent by
   * construction and must not depend on `@wallet/solana` — the direction of
   * that dependency is the whole reason the package exists.
   */
  function base58(bytes: Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);

    let out = '';
    while (value > 0n) {
      out = ALPHABET[Number(value % 58n)] + out;
      value /= 58n;
    }
    for (const byte of bytes) {
      if (byte !== 0) break;
      out = '1' + out;
    }
    return out;
  }

  function publicKeyFor(keyRef: KeyRef): Uint8Array {
    return new Uint8Array(
      createHash('sha256')
        .update(`${seed}:pub:${keyRef.id}`)
        .digest()
        .subarray(0, PUBLIC_KEY_BYTES),
    );
  }

  return {
    kind: 'mock',

    async getPublicKey(keyRef) {
      return publicKeyFor(keyRef);
    },

    /**
     * A per-user "threshold group" that is nothing of the kind.
     *
     * One deterministic key, derived from the seed, presented as a 3-of-5
     * group. It exists so the segregated withdrawal path — pay from the user's
     * own address, sign with the user's own key, house pays the fee — can be
     * exercised end to end without five participant processes. The property it
     * genuinely provides is the one those tests depend on: DIFFERENT users get
     * DIFFERENT addresses, and the address is the public key of whatever signs
     * for it.
     *
     * Idempotent for free, because it is a pure function of the seed and the
     * key reference.
     */
    async provisionKey(keyRef: KeyRef): Promise<ProvisionedKey> {
      announce(`provision:${keyRef.id}`);
      return {
        keyRef: keyRef.id,
        address: base58(publicKeyFor(keyRef)),
        threshold: 3,
        participants: 5,
        // Always false: nothing is stored, so this mock cannot distinguish a
        // first provisioning from a repeat. A test that needs that distinction
        // needs the real coordinator.
        existing: false,
      };
    },

    async sign(request: SignRequest): Promise<SignResult> {
      calls += 1;
      announce(request.requestId);

      // Longest prefix wins, so a fault aimed at one exact request beats a
      // broader one aimed at the withdrawal.
      let faultKey: string | undefined;
      for (const key of faults.keys()) {
        if (
          request.requestId.startsWith(key) &&
          (faultKey === undefined || key.length > faultKey.length)
        ) {
          faultKey = key;
        }
      }
      const fault = faultKey === undefined ? undefined : faults.get(faultKey);
      if (faultKey !== undefined) faults.delete(faultKey);

      if (fault === 'fail') {
        throw new Error(`mock signer: injected failure for ${request.requestId}`);
      }
      if (fault === 'hang') {
        // Never resolves. The caller's timeout is what ends this, which is the
        // point — a signer that hangs must not hang the whole system.
        return new Promise<SignResult>(() => undefined);
      }
      if (fault === 'timeout') {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      }

      /**
       * IDEMPOTENCY (rules 123-124).
       *
       * The same requestId returns the cached result and starts no second
       * round. `roundCount()` is what a test asserts against, because
       * "it returned the same bytes" is weaker than "it did not sign again".
       */
      const cached = completed.get(request.requestId);
      if (cached !== undefined && fault !== 'duplicate_round') {
        return cached;
      }

      rounds += 1;

      if (fault === 'malformed') {
        return {
          requestId: request.requestId,
          signature: new Uint8Array(7), // wrong length on purpose
          publicKey: publicKeyFor(request.keyRef),
        };
      }

      const result = derive(request.keyRef, request.requestId, request.payload);
      completed.set(request.requestId, result);
      return result;
    },

    injectFault(requestId, fault) {
      faults.set(requestId, fault);
    },

    clearFaults() {
      faults.clear();
    },

    roundCount() {
      return rounds;
    },

    callCount() {
      return calls;
    },
  };
}
