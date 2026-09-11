import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizationMessage, mpcCanonicalString, signAuthorization } from '../src/index.js';

/**
 * The wire contract between this client and `services/mpc`.
 *
 * `services/mpc/tests/boundary.rs::the_canonical_signing_string_is_stable` pins
 * the same format on the Rust side. These two tests are the contract: if they
 * ever disagree, every signing request is rejected — which is a far better
 * failure than the alternative, and this is where it surfaces.
 */
describe('the canonical signing string', () => {
  const payloadHash = createHash('sha256').update('payload').digest();

  it('matches the format the Rust service verifies', () => {
    const canonical = mpcCanonicalString({
      method: 'POST',
      path: '/v1/sign',
      requestId: 'req-1',
      payloadHash,
      timestamp: 1_700_000_000,
    });

    expect(canonical).toBe(`POST\n/v1/sign\nreq-1\n${payloadHash.toString('hex')}\n1700000000`);
  });

  it('separates fields with a character no field can contain', () => {
    // Without this, ("ab", "c") and ("a", "bc") produce the same signing input
    // and one signature covers both.
    const a = mpcCanonicalString({
      method: 'POST',
      path: '/v1/sign',
      requestId: 'ab',
      payloadHash,
      timestamp: 1,
    });
    const b = mpcCanonicalString({
      method: 'POST',
      path: '/v1/sign',
      requestId: 'a',
      payloadHash,
      timestamp: 1,
    });

    expect(a).not.toBe(b);
    expect(a.split('\n')).toHaveLength(5);
  });

  it('covers the payload by hash rather than by value', () => {
    // Bounded, and nothing is tempted to log the payload.
    const big = createHash('sha256').update('x'.repeat(100_000)).digest();
    const canonical = mpcCanonicalString({
      method: 'POST',
      path: '/v1/sign',
      requestId: 'r',
      payloadHash: big,
      timestamp: 1,
    });
    expect(canonical.length).toBeLessThan(200);
  });

  it('changes when any covered field changes', () => {
    const base = {
      method: 'POST',
      path: '/v1/sign',
      requestId: 'r1',
      payloadHash,
      timestamp: 1000,
    };
    const baseline = mpcCanonicalString(base);

    const variants = [
      { ...base, method: 'GET' },
      { ...base, path: '/v1/public-key' },
      { ...base, requestId: 'r2' },
      { ...base, payloadHash: createHash('sha256').update('other').digest() },
      { ...base, timestamp: 1001 },
    ];

    for (const variant of variants) {
      expect(mpcCanonicalString(variant)).not.toBe(baseline);
    }
  });

  it('produces a signature the Rust verifier would accept', () => {
    // Ed25519 in Node takes a null algorithm — the scheme prehashes internally,
    // which is the detail that silently produces wrong signatures if missed.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const message = Buffer.from(
      mpcCanonicalString({
        method: 'POST',
        path: '/v1/sign',
        requestId: 'r1',
        payloadHash,
        timestamp: 1_700_000_000,
      }),
    );

    const signature = edSign(null, message, privateKey);
    expect(signature).toHaveLength(64);
    expect(edVerify(null, message, publicKey, signature)).toBe(true);
    // A different message must not verify.
    expect(edVerify(null, Buffer.from('tampered'), publicKey, signature)).toBe(false);
  });
});

/**
 * The authorization message, pinned on both sides.
 *
 * `services/mpc/src/signer.rs::authorization_message` builds the same string.
 * If these drift, the signing service refuses every request — a far better
 * failure than the alternative, and this is where it surfaces.
 */
describe('the authorization message (ADR-0015)', () => {
  const proof = {
    approvedBy: 'risk-engine',
    approvedAt: '2026-09-11T12:00:00Z',
    policyVersion: '1',
    reference: 'withdrawal-1',
  };
  const payload = new Uint8Array([1, 2, 3]);

  it('matches the format the Rust service verifies', () => {
    const hash = createHash('sha256').update(payload).digest('hex');
    expect(authorizationMessage(proof, payload)).toBe(
      `risk-engine\n2026-09-11T12:00:00Z\n1\nwithdrawal-1\n${hash}`,
    );
  });

  it('binds the proof to the payload', () => {
    // THE property that matters: without it, a genuine approval for one
    // withdrawal could be replayed onto another.
    const forOne = authorizationMessage(proof, new Uint8Array([1]));
    const forAnother = authorizationMessage(proof, new Uint8Array([2]));
    expect(forOne).not.toBe(forAnother);
  });

  it('changes when any field of the proof changes', () => {
    const baseline = authorizationMessage(proof, payload);
    for (const variant of [
      { ...proof, approvedBy: 'someone-else' },
      { ...proof, approvedAt: '2030-01-01T00:00:00Z' },
      { ...proof, policyVersion: '2' },
      { ...proof, reference: 'withdrawal-2' },
    ]) {
      expect(authorizationMessage(variant, payload)).not.toBe(baseline);
    }
  });

  it('produces a signature the Rust verifier would accept', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signed = signAuthorization(proof, payload, privateKey);

    expect(signed.signature).toBeTruthy();
    const signature = Buffer.from(signed.signature!, 'base64');
    expect(signature).toHaveLength(64);

    expect(
      edVerify(null, Buffer.from(authorizationMessage(proof, payload)), publicKey, signature),
    ).toBe(true);

    // And is worthless over a different payload.
    expect(
      edVerify(
        null,
        Buffer.from(authorizationMessage(proof, new Uint8Array([9]))),
        publicKey,
        signature,
      ),
    ).toBe(false);
  });
});
