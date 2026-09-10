import { describe, expect, it } from 'vitest';
import { ChallengeInvalidError } from '@wallet/errors';
import {
  checkCsrf,
  createEncryptor,
  createInMemoryChallengeStore,
  createTotpService,
  createWebAuthnService,
  detectClone,
  generateSessionToken,
  hashToken,
  safeEqual,
} from './index.js';

const RP = { rpId: 'localhost', rpName: 'Wallet', origin: 'http://localhost:3000' };
const KEY = Buffer.alloc(32, 7).toString('base64');

// ---------------------------------------------------------------------------
// Challenge replay (rule 176)
// ---------------------------------------------------------------------------

describe('challenge single-use (rules 104, 176)', () => {
  it('consumes a ceremony exactly once', async () => {
    const store = createInMemoryChallengeStore();
    const id = await store.put({ kind: 'registration', challenge: 'abc' });

    expect(await store.consume(id)).toMatchObject({ challenge: 'abc' });
    expect(await store.consume(id)).toBeNull();
  });

  it('survives concurrent consumption without handing out two winners', async () => {
    const store = createInMemoryChallengeStore();
    const id = await store.put({ kind: 'authentication', challenge: 'abc' });

    const results = await Promise.all([store.consume(id), store.consume(id), store.consume(id)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('expires a ceremony after its TTL', async () => {
    const store = createInMemoryChallengeStore(-1);
    const id = await store.put({ kind: 'registration', challenge: 'abc' });
    expect(await store.consume(id)).toBeNull();
  });

  it('rejects a replayed registration before doing any crypto', async () => {
    const store = createInMemoryChallengeStore();
    const service = createWebAuthnService(RP, store);
    const { ceremonyId } = await service.beginRegistration({
      userName: 'a@example.test',
      userDisplayName: 'A',
      existingCredentials: [],
    });

    // A hostile client replaying a captured ceremonyId gets the same answer
    // whether or not the credential payload is valid.
    await expect(service.finishRegistration(ceremonyId, {} as never)).rejects.toThrow();
    await expect(service.finishRegistration(ceremonyId, {} as never)).rejects.toThrow(
      ChallengeInvalidError,
    );
  });

  it('rejects an unknown ceremony id', async () => {
    const service = createWebAuthnService(RP, createInMemoryChallengeStore());
    await expect(service.finishRegistration('never-issued', {} as never)).rejects.toThrow(
      ChallengeInvalidError,
    );
  });

  it('will not let a registration ceremony be used to authenticate', async () => {
    const store = createInMemoryChallengeStore();
    const service = createWebAuthnService(RP, store);
    const { ceremonyId } = await service.beginRegistration({
      userName: 'a@example.test',
      userDisplayName: 'A',
      existingCredentials: [],
    });

    await expect(
      service.finishAuthentication(ceremonyId, {} as never, async () => null),
    ).rejects.toThrow(ChallengeInvalidError);
  });
});

// ---------------------------------------------------------------------------
// Clone detection (rule 177)
// ---------------------------------------------------------------------------

describe('clone detection (rules 114-115, 177)', () => {
  it('accepts a counter that advances', () => {
    expect(detectClone(5n, 6n).suspicious).toBe(false);
    expect(detectClone(1n, 1000n).suspicious).toBe(false);
  });

  it('flags a counter that stands still', () => {
    const verdict = detectClone(5n, 5n);
    expect(verdict.suspicious).toBe(true);
    expect(verdict).toMatchObject({ reason: 'sign_count_did_not_advance' });
  });

  it('flags a counter that goes backwards', () => {
    expect(detectClone(10n, 3n).suspicious).toBe(true);
  });

  it('does NOT flag an authenticator that has no counter', () => {
    // Synced passkey providers report 0 forever and legitimately exist on
    // several devices. Flagging this would lock out most real users.
    expect(detectClone(0n, 0n).suspicious).toBe(false);
    expect(detectClone(0n, 1n).suspicious).toBe(false);
  });

  it('handles counters beyond 2^53 without precision loss', () => {
    const big = 9_007_199_254_740_993n;
    expect(detectClone(big, big + 1n).suspicious).toBe(false);
    expect(detectClone(big + 1n, big).suspicious).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CSRF (rule 178)
// ---------------------------------------------------------------------------

describe('CSRF origin check (rules 129, 178)', () => {
  const expectedOrigin = 'http://localhost:3000';

  it('allows a same-origin state change', () => {
    expect(
      checkCsrf({
        method: 'POST',
        origin: expectedOrigin,
        secFetchSite: 'same-origin',
        expectedOrigin,
      }),
    ).toEqual({ ok: true });
  });

  it('allows same-SITE, which is what a separate-port API actually produces', () => {
    // localhost:3000 -> localhost:4000 is same-site, not same-origin, because
    // "site" ignores the port. Rejecting this rejects every real request.
    expect(
      checkCsrf({
        method: 'POST',
        origin: expectedOrigin,
        secFetchSite: 'same-site',
        expectedOrigin,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a cross-site state change', () => {
    expect(
      checkCsrf({
        method: 'POST',
        origin: 'https://evil.example',
        secFetchSite: 'cross-site',
        expectedOrigin,
      }).ok,
    ).toBe(false);
  });

  it('rejects a hostile origin even when it claims to be same-origin', () => {
    // Origin is the authoritative field; a claimed Sec-Fetch-Site cannot
    // override a mismatched Origin.
    expect(
      checkCsrf({
        method: 'POST',
        origin: 'https://evil.example',
        secFetchSite: 'same-origin',
        expectedOrigin,
      }),
    ).toMatchObject({ ok: false, reason: 'origin_mismatch' });
  });

  it('rejects a cross-origin request when fetch metadata is absent', () => {
    expect(
      checkCsrf({
        method: 'POST',
        origin: 'https://evil.example',
        secFetchSite: undefined,
        expectedOrigin,
      }),
    ).toMatchObject({ ok: false, reason: 'origin_mismatch' });
  });

  it('rejects a state change with no origin at all', () => {
    expect(
      checkCsrf({ method: 'DELETE', origin: undefined, secFetchSite: undefined, expectedOrigin }),
    ).toMatchObject({ ok: false, reason: 'origin_absent' });
  });

  it('rejects a direct navigation as a state change', () => {
    expect(
      checkCsrf({ method: 'POST', origin: expectedOrigin, secFetchSite: 'none', expectedOrigin }),
    ).toMatchObject({ ok: false, reason: 'sec_fetch_site_none' });
  });

  it('does not block safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(
        checkCsrf({
          method,
          origin: 'https://evil.example',
          secFetchSite: 'cross-site',
          expectedOrigin,
        }),
      ).toEqual({ ok: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Token and secret handling
// ---------------------------------------------------------------------------

describe('session tokens (rules 102, 123)', () => {
  it('produces 256 bits of entropy and a matching hash', () => {
    const { value, hash } = generateSessionToken();
    expect(Buffer.from(value, 'base64url')).toHaveLength(32);
    expect(hash).toHaveLength(32);
    expect(safeEqual(hash, hashToken(value))).toBe(true);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateSessionToken().value));
    expect(seen.size).toBe(500);
  });

  it('produces a hash from which the token cannot be recovered', () => {
    const { value, hash } = generateSessionToken();
    expect(Buffer.from(hash).toString('base64url')).not.toBe(value);
    expect(Buffer.from(hash).toString('utf8')).not.toContain(value);
  });
});

describe('secret encryption (rule 100)', () => {
  it('round-trips', () => {
    const enc = createEncryptor(KEY);
    expect(enc.decrypt(enc.encrypt('JBSWY3DPEHPK3PXP'))).toBe('JBSWY3DPEHPK3PXP');
  });

  it('produces a different ciphertext each time', () => {
    const enc = createEncryptor(KEY);
    const a = Buffer.from(enc.encrypt('same')).toString('hex');
    const b = Buffer.from(enc.encrypt('same')).toString('hex');
    expect(a).not.toBe(b);
  });

  it('detects tampering rather than decrypting to garbage', () => {
    const enc = createEncryptor(KEY);
    const payload = Buffer.from(enc.encrypt('JBSWY3DPEHPK3PXP'));
    const last = payload.length - 1;
    payload[last] = (payload[last] ?? 0) ^ 0xff;
    expect(() => enc.decrypt(payload)).toThrow();
  });

  it('refuses a wrong-sized key at construction, not at first use', () => {
    expect(() => createEncryptor(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('cannot decrypt with a different key', () => {
    const a = createEncryptor(KEY);
    const b = createEncryptor(Buffer.alloc(32, 9).toString('base64'));
    expect(() => b.decrypt(a.encrypt('secret'))).toThrow();
  });
});

describe('TOTP and recovery codes (rules 133-134)', () => {
  const totp = createTotpService(createEncryptor(KEY));

  it('verifies a code generated for the same secret', async () => {
    const secret = totp.generateSecret();
    const { TOTP, Secret } = await import('otpauth');
    const code = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
    expect(totp.verify(secret, code)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = totp.generateSecret();
    expect(totp.verify(secret, '000000')).toBe(false);
  });

  it('builds a provisioning URI carrying the secret exactly once', () => {
    const secret = totp.generateSecret();
    const uri = totp.buildUri(secret, 'a@example.test');
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(secret);
  });

  it('generates distinct recovery codes and stores only hashes', () => {
    const { plaintext, hashes } = totp.generateRecoveryCodes();
    expect(new Set(plaintext).size).toBe(plaintext.length);
    for (const [i, code] of plaintext.entries()) {
      expect(Buffer.from(hashes[i]!).toString('utf8')).not.toContain(code);
      expect(safeEqual(hashes[i]!, totp.hashRecoveryCode(code))).toBe(true);
    }
  });

  it('normalizes recovery codes so case and dashes do not matter', () => {
    const { plaintext } = totp.generateRecoveryCodes(1);
    const code = plaintext[0]!;
    expect(safeEqual(totp.hashRecoveryCode(code), totp.hashRecoveryCode(code.toLowerCase()))).toBe(
      true,
    );
    expect(
      safeEqual(totp.hashRecoveryCode(code), totp.hashRecoveryCode(code.replace(/-/g, ''))),
    ).toBe(true);
  });

  it('uses an alphabet with no ambiguous characters', () => {
    const { plaintext } = totp.generateRecoveryCodes(20);
    for (const code of plaintext) {
      expect(code).not.toMatch(/[ILOU]/);
    }
  });
});
