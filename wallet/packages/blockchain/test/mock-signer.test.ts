import { describe, expect, it, vi } from 'vitest';
import { createMockSigner, type SignRequest } from '../src/index.js';

const KEY = { id: 'key-1' };
const AUTH = {
  approvedBy: 'risk-engine',
  approvedAt: '2026-09-11T12:00:00.000Z',
  policyVersion: '1',
  reference: 'withdrawal-1',
};

function request(requestId: string, payload = new Uint8Array([1, 2, 3])): SignRequest {
  return { requestId, keyRef: KEY, payload, authorization: AUTH };
}

const silent = { onBanner: () => undefined };

describe('production refusal (rules 125, 179, 196)', () => {
  it('refuses to construct when NODE_ENV is production', () => {
    expect(() => createMockSigner({ nodeEnv: 'production' })).toThrow(/never run in production/);
  });

  it('constructs in every other environment', () => {
    for (const nodeEnv of ['development', 'test', 'staging', undefined]) {
      expect(() => createMockSigner({ ...silent, ...(nodeEnv ? { nodeEnv } : {}) })).not.toThrow();
    }
  });

  it('fails hard rather than warning', () => {
    // A warning is a line in a log nobody reads. The process must not start.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => createMockSigner({ nodeEnv: 'production' })).toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the banner (rule 126)', () => {
  it('announces itself on every call', async () => {
    const banners: string[] = [];
    const signer = createMockSigner({ onBanner: (m) => banners.push(m) });

    await signer.sign(request('r1'));
    await signer.sign(request('r2'));

    expect(banners).toHaveLength(2);
    for (const banner of banners) {
      expect(banner).toMatch(/MOCK SIGNER/);
      expect(banner).toMatch(/not real cryptography/);
    }
  });

  it('announces even a cached result, so the call is never invisible', async () => {
    const banners: string[] = [];
    const signer = createMockSigner({ onBanner: (m) => banners.push(m) });
    await signer.sign(request('r1'));
    await signer.sign(request('r1'));
    expect(banners).toHaveLength(2);
  });
});

describe('determinism and idempotency (rules 123-124)', () => {
  it('the same requestId always yields the same signature', async () => {
    const signer = createMockSigner(silent);
    const a = await signer.sign(request('r1'));
    const b = await signer.sign(request('r1'));
    expect(Buffer.from(b.signature)).toEqual(Buffer.from(a.signature));
  });

  it('the same requestId does not start a SECOND signing round', async () => {
    // Stronger than "same bytes": under threshold signing a duplicate round is
    // a nonce-reuse hazard, so what matters is that no round happened.
    const signer = createMockSigner(silent);
    for (let i = 0; i < 10; i += 1) await signer.sign(request('r1'));

    expect(signer.callCount()).toBe(10);
    expect(signer.roundCount()).toBe(1);
  });

  it('different requestIds produce different signatures', async () => {
    const signer = createMockSigner(silent);
    const a = await signer.sign(request('r1'));
    const b = await signer.sign(request('r2'));
    expect(Buffer.from(a.signature)).not.toEqual(Buffer.from(b.signature));
  });

  it('survives a restart with the same seed', async () => {
    const first = createMockSigner({ ...silent, seed: 'fixed' });
    const second = createMockSigner({ ...silent, seed: 'fixed' });
    const a = await first.sign(request('r1'));
    const b = await second.sign(request('r1'));
    expect(Buffer.from(b.signature)).toEqual(Buffer.from(a.signature));
  });

  it('produces a signature of the right shape', async () => {
    const signer = createMockSigner(silent);
    const result = await signer.sign(request('r1'));
    expect(result.signature).toHaveLength(64);
    expect(result.publicKey).toHaveLength(32);
    expect(result.requestId).toBe('r1');
  });

  it('exposes a stable public key per key reference', async () => {
    const signer = createMockSigner(silent);
    const a = await signer.getPublicKey(KEY);
    const b = await signer.getPublicKey(KEY);
    const other = await signer.getPublicKey({ id: 'key-2' });
    expect(Buffer.from(b)).toEqual(Buffer.from(a));
    expect(Buffer.from(other)).not.toEqual(Buffer.from(a));
  });
});

describe('fault injection (rules 127-128, 172, 197)', () => {
  it('fails on demand', async () => {
    const signer = createMockSigner(silent);
    signer.injectFault('r1', 'fail');
    await expect(signer.sign(request('r1'))).rejects.toThrow(/injected failure/);
  });

  it('consumes a fault, so a retry can succeed', async () => {
    // The shape of a transient signer failure: one attempt fails, the next
    // works. Without this the retry path could not be tested at all.
    const signer = createMockSigner(silent);
    signer.injectFault('r1', 'fail');
    await expect(signer.sign(request('r1'))).rejects.toThrow();
    await expect(signer.sign(request('r1'))).resolves.toBeTruthy();
  });

  it("hangs on demand, so the caller's timeout is what ends it", async () => {
    const signer = createMockSigner(silent);
    signer.injectFault('r1', 'hang');

    const raced = await Promise.race([
      signer.sign(request('r1')).then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);
    expect(raced).toBe('timed-out');
  });

  it('returns a malformed signature on demand', async () => {
    const signer = createMockSigner(silent);
    signer.injectFault('r1', 'malformed');
    const result = await signer.sign(request('r1'));
    expect(result.signature).not.toHaveLength(64);
  });

  it('can be made to break its own idempotency contract', async () => {
    // Deliberately provokes the thing that must never happen, so the caller's
    // handling of it is testable.
    const signer = createMockSigner(silent);
    await signer.sign(request('r1'));
    expect(signer.roundCount()).toBe(1);

    signer.injectFault('r1', 'duplicate_round');
    await signer.sign(request('r1'));
    expect(signer.roundCount()).toBe(2);
  });

  it('clears injected faults', async () => {
    const signer = createMockSigner(silent);
    signer.injectFault('r1', 'fail');
    signer.clearFaults();
    await expect(signer.sign(request('r1'))).resolves.toBeTruthy();
  });

  it('affects only the targeted request', async () => {
    const signer = createMockSigner(silent);
    signer.injectFault('r1', 'fail');
    await expect(signer.sign(request('r2'))).resolves.toBeTruthy();
    await expect(signer.sign(request('r1'))).rejects.toThrow();
  });
});

describe('the signer stays chain-agnostic (rule 133)', () => {
  it('signs arbitrary bytes without inspecting them', async () => {
    const signer = createMockSigner(silent);
    for (const payload of [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array(1232).fill(9), // a full Solana transaction's worth
    ]) {
      await expect(
        signer.sign({
          requestId: `r-${payload.length}`,
          keyRef: KEY,
          payload,
          authorization: AUTH,
        }),
      ).resolves.toBeTruthy();
    }
  });

  it('carries an authorization proof it does not evaluate', async () => {
    // Authorising and signing are separate concerns (master-prompt rule 109).
    // A signer that decided whether to sign could not be moved into its own
    // trust domain in Phase 4.
    const signer = createMockSigner(silent);
    const result = await signer.sign({
      requestId: 'r1',
      keyRef: KEY,
      payload: new Uint8Array([1]),
      authorization: { ...AUTH, approvedBy: 'anyone-at-all' },
    });
    expect(result.signature).toHaveLength(64);
  });
});
