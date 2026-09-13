import { createHash, sign as edSign, type KeyObject } from 'node:crypto';
import type {
  KeyProvisioner,
  KeyRef,
  ProvisionedKey,
  SignRequest,
  SignResult,
  Signer,
} from '../signer.js';

/**
 * A client for `services/mpc` (ADR-0013).
 *
 * Transport only. Key generation, storage, signing and idempotency all live in
 * the Rust service; this file's entire job is to speak its wire protocol
 * correctly and to satisfy the `Signer` interface **without changing it**.
 *
 * That last part is the point. If this file had needed the interface widened,
 * the abstraction would have leaked and three phases of tests would have been
 * built on a lie (prompt_phase4.md rules 10, 67).
 */

export interface RustSignerOptions {
  readonly endpoint: string;
  /**
   * The caller's Ed25519 private key, PKCS#8 DER or PEM.
   *
   * The service holds only the corresponding public key, so a compromise of the
   * service does not yield the ability to impersonate this caller — which
   * matters in 4b, where five participants each hold one.
   */
  readonly clientPrivateKey: KeyObject;
  readonly callerName: string;
  readonly requestTimeoutMs: number;
}

/** What the service on the other end actually is. */
export type MpcRole = 'single-key' | 'participant' | 'coordinator';

export interface RustSigner extends Signer, KeyProvisioner {
  /**
   * `rust-mpc`, not `rust-single-key`.
   *
   * This value is recorded on every signing request as the audit trail's
   * answer to "what signed this". It said `rust-single-key` while the client
   * was talking to a 3-of-5 coordinator, which is a false statement in the one
   * record kept specifically to be read later. The client is the same either
   * way; `describe()` is how the deployment's actual shape is learned.
   */
  readonly kind: 'rust-mpc';
  isHealthy(): Promise<boolean>;
  /** The service's role, or undefined when it cannot be reached. */
  describe(): Promise<MpcRole | undefined>;
}

interface SignResponseBody {
  requestId: string;
  signature: string;
  publicKey: string;
  replayed: boolean;
}

/**
 * The exact bytes the service verifies.
 *
 * Newline-separated, with the payload covered by its SHA-256 rather than its
 * bytes — so the string stays bounded, and so nothing tempts anyone to log it.
 *
 * The separator matters: without a character no field can contain,
 * `("ab", "c")` and `("a", "bc")` would produce the same signing input and one
 * signature would cover both. `services/mpc/tests/boundary.rs` pins this
 * format; if the two disagree, every request is rejected — which is a far
 * better failure than the alternative.
 */
function canonicalString(input: {
  method: string;
  path: string;
  requestId: string;
  payloadHash: Buffer;
  timestamp: number;
}): string {
  return [
    input.method,
    input.path,
    input.requestId,
    input.payloadHash.toString('hex'),
    String(input.timestamp),
  ].join('\n');
}

export function createRustSigner(options: RustSignerOptions): RustSigner {
  function authHeaders(
    method: string,
    path: string,
    requestId: string,
    payload: Uint8Array,
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const payloadHash = createHash('sha256').update(payload).digest();

    // Ed25519 in Node takes a null algorithm — the scheme prehashes internally.
    const signature = edSign(
      null,
      Buffer.from(canonicalString({ method, path, requestId, payloadHash, timestamp })),
      options.clientPrivateKey,
    );

    return {
      'x-mpc-signature': signature.toString('base64'),
      'x-mpc-timestamp': String(timestamp),
      'x-mpc-caller': options.callerName,
    };
  }

  /**
   * `body` is already serialized.
   *
   * The service authenticates some endpoints over the exact request BYTES, so
   * the string that is signed and the string that is sent must be the same
   * one. Serializing here from an object would mean signing a different
   * serialization than the one transmitted the moment anything about the shape
   * changed — and the only symptom would be `signature_rejected`.
   */
  async function call<T>(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);

    try {
      const response = await fetch(`${options.endpoint}${path}`, {
        method,
        headers: {
          ...headers,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        // The service's error codes are coarse by design, and the endpoint may
        // carry credentials — so neither the body nor the URL is forwarded.
        let code = 'UNKNOWN';
        try {
          code = (JSON.parse(text) as { code?: string }).code ?? 'UNKNOWN';
        } catch {
          /* a non-JSON error body is itself the signal */
        }
        throw new Error(`MPC service rejected the request: ${code}`);
      }

      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: 'rust-mpc',

    async getPublicKey(keyRef: KeyRef): Promise<Uint8Array> {
      // The request id slot carries the key reference for this endpoint, so the
      // signature still covers what is being asked for.
      const headers = authHeaders('GET', '/v1/public-key', keyRef.id, new Uint8Array());
      const body = await call<{ publicKey: string }>(
        'GET',
        `/v1/public-key?keyRef=${encodeURIComponent(keyRef.id)}`,
        headers,
      );
      return new Uint8Array(Buffer.from(body.publicKey, 'base64'));
    },

    /**
     * Request a signature.
     *
     * Idempotency is NOT implemented here. The service enforces it, because a
     * client-side guard protects against nothing — a retrying client, a
     * duplicated queue message, or a hostile caller all bypass it
     * (ADR-0013, prompt_phase4.md rule 64).
     */
    async sign(request: SignRequest): Promise<SignResult> {
      const headers = authHeaders('POST', '/v1/sign', request.requestId, request.payload);

      const body = await call<SignResponseBody>(
        'POST',
        '/v1/sign',
        headers,
        JSON.stringify({
          requestId: request.requestId,
          keyRef: request.keyRef.id,
          payload: Buffer.from(request.payload).toString('base64'),
          authorization: request.authorization,
        }),
      );

      const signature = new Uint8Array(Buffer.from(body.signature, 'base64'));
      if (signature.length !== 64) {
        throw new Error(`MPC service returned ${signature.length} bytes, expected 64`);
      }

      return {
        requestId: body.requestId,
        signature,
        publicKey: new Uint8Array(Buffer.from(body.publicKey, 'base64')),
      };
    },

    /**
     * Create this user's threshold key, or return the one that exists.
     *
     * Answered by the COORDINATOR. A single-key service rejects it with
     * `not_a_coordinator`, which is the correct answer rather than a failure
     * to handle: a deployment without a coordinator has no per-user keys to
     * hand out, and silently falling back to a derived address would be the
     * thing ADR-0020 exists to prevent.
     *
     * Unlike `/v1/sign`, this endpoint authenticates over the request BYTES,
     * so the body is serialized once and both signed and sent.
     */
    async provisionKey(keyRef: KeyRef): Promise<ProvisionedKey> {
      const body = JSON.stringify({ keyRef: keyRef.id });
      const headers = authHeaders(
        'POST',
        '/v1/frost/provision',
        keyRef.id,
        Buffer.from(body, 'utf8'),
      );

      const response = await call<{
        keyRef: string;
        groupPublicKey: string;
        threshold: number;
        participants: number;
        existing: boolean;
      }>('POST', '/v1/frost/provision', headers, body);

      return {
        keyRef: response.keyRef,
        address: response.groupPublicKey,
        threshold: response.threshold,
        participants: response.participants,
        existing: response.existing,
      };
    },

    async isHealthy(): Promise<boolean> {
      try {
        const body = await call<{ status: string }>('GET', '/v1/health', {});
        return body.status === 'ok';
      } catch {
        return false;
      }
    },

    /**
     * What the service is, from its own health endpoint.
     *
     * Probed rather than configured: a deployment that pointed
     * `MPC_ENDPOINT` at a coordinator and forgot to update a flag would tell
     * users their custody is weaker than it is — or, worse, the reverse.
     *
     * Undefined on failure, and every caller treats that as "assume the weaker
     * claim". A platform that cannot say what its signing is should not be
     * making the stronger statement.
     */
    async describe(): Promise<MpcRole | undefined> {
      try {
        const body = await call<{ role?: string }>('GET', '/v1/health', {});
        return body.role === 'coordinator' || body.role === 'participant'
          ? body.role
          : 'single-key';
      } catch {
        return undefined;
      }
    },
  };
}

export { canonicalString as mpcCanonicalString };
