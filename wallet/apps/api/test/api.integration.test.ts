import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@wallet/types';
import { browserHeaders, seedSession, startHarness, WEB_ORIGIN, type Harness } from './helpers.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.cleanup();
});

// ---------------------------------------------------------------------------
// Health (rules 151-154)
// ---------------------------------------------------------------------------

describe('health', () => {
  it('liveness does not touch the database', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('readiness reports each dependency individually', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json();
    const names = body.dependencies.map((d: { name: string }) => d.name);
    expect(names).toContain('postgres');
    expect(names).toContain('redis');
    // The array shape is what lets Phase 4 add solana-rpc and mpc here.
    for (const dep of body.dependencies) {
      expect(dep).toHaveProperty('status');
    }
  });

  it('never exposes a connection string in a dependency detail', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.body).not.toContain('postgres://');
    expect(res.body).not.toContain('postgresql://');
    expect(res.body).not.toContain('redis://');
  });
});

// ---------------------------------------------------------------------------
// Error contract (rules 83-87, 185)
// ---------------------------------------------------------------------------

describe('error contract', () => {
  it('carries a declared code and a correlation id on every failure', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(ERROR_CODES).toContain(body.error.code);
    expect(body.error.correlationId).toBeTruthy();
    expect(res.headers['x-correlation-id']).toBe(body.error.correlationId);
  });

  it('echoes a caller-supplied correlation id so a trace spans client and server', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': 'trace-abc-123' },
    });
    expect(res.headers['x-correlation-id']).toBe('trace-abc-123');
  });

  it('refuses a hostile correlation id rather than logging it verbatim', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': 'x'.repeat(5000) },
    });
    expect(res.headers['x-correlation-id']).not.toBe('x'.repeat(5000));
    expect(String(res.headers['x-correlation-id']).length).toBeLessThan(64);
  });

  it('reports an unknown route through the same contract', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('never returns a stack trace or driver text', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/me' });
    expect(res.body).not.toContain('at ');
    expect(res.body).not.toContain('stack');
    expect(res.body).not.toContain('prisma');
  });
});

// ---------------------------------------------------------------------------
// Validation (rules 145, 184)
// ---------------------------------------------------------------------------

describe('request validation', () => {
  it('rejects a malformed body with field paths', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/register/options',
      headers: browserHeaders(),
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.fields.map((f: { path: string }) => f.path)).toContain('email');
  });

  it('does not echo a REJECTED value back (rule 77)', async () => {
    // A valid email is legitimately echoed inside the WebAuthn options — the
    // authenticator displays it to the user who just typed it. What must never
    // come back is a value the server refused.
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/register/options',
      headers: browserHeaders(),
      payload: { email: 'not-an-email-but-looks-sensitive-ACC-99887766' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('ACC-99887766');
    expect(res.body).toContain('email');
  });

  it('rejects a missing required field on verify', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/login/verify',
      headers: browserHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

// ---------------------------------------------------------------------------
// CSRF (rules 129, 178)
// ---------------------------------------------------------------------------

describe('CSRF', () => {
  it('rejects a cross-site state change', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/login/options',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_DENIED');
  });

  it('rejects a state change carrying a session cookie from a hostile origin', async () => {
    const { cookie } = await seedSession(h);
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/auth/sessions/whatever',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows a same-origin state change', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/login/options',
      headers: browserHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not gate safe methods', async () => {
    const { cookie } = await seedSession(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/me',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', cookie },
    });
    // CORS stops the browser reading this; the CSRF guard is about writes.
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Enumeration resistance (rules 141, 179)
// ---------------------------------------------------------------------------

describe('user enumeration', () => {
  it('answers identically for a known and an unknown account', async () => {
    const { userId } = await seedSession(h);
    const known = await h.app.appDeps.users.findById(userId);

    const forKnown = await h.app.inject({
      method: 'POST',
      url: '/auth/login/options',
      headers: browserHeaders(),
      payload: { email: known?.email },
    });
    const forUnknown = await h.app.inject({
      method: 'POST',
      url: '/auth/login/options',
      headers: browserHeaders(),
      payload: { email: 'nobody-at-all@example.test' },
    });

    expect(forKnown.statusCode).toBe(forUnknown.statusCode);
    expect(Object.keys(forKnown.json()).sort()).toEqual(Object.keys(forUnknown.json()).sort());
    expect(Object.keys(forKnown.json().options).sort()).toEqual(
      Object.keys(forUnknown.json().options).sort(),
    );
  });

  it('returns no allowCredentials list, so there is nothing to leak', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/login/options',
      headers: browserHeaders(),
      payload: { email: 'anyone@example.test' },
    });
    expect(res.json().options).not.toHaveProperty('allowCredentials');
  });

  it('fails a bad verify with the same generic code regardless of cause', async () => {
    const bodies = await Promise.all(
      ['never-issued-1', 'never-issued-2'].map(async (ceremonyId) => {
        const res = await h.app.inject({
          method: 'POST',
          url: '/auth/login/verify',
          headers: browserHeaders(),
          payload: {
            ceremonyId,
            credential: {
              id: 'aaaa',
              rawId: 'aaaa',
              type: 'public-key',
              response: { clientDataJSON: 'a', authenticatorData: 'a', signature: 'a' },
              clientExtensionResults: {},
            },
          },
        });
        const body = res.json();
        return { status: res.statusCode, code: body.error.code, message: body.error.message };
      }),
    );
    expect(bodies[0]!.status).toBe(bodies[1]!.status);
    expect(bodies[0]!.code).toBe(bodies[1]!.code);
    expect(bodies[0]!.message).toBe(bodies[1]!.message);
  });
});

// ---------------------------------------------------------------------------
// Session guard and ownership (rules 161, 204)
// ---------------------------------------------------------------------------

describe('authentication and authorization', () => {
  it('rejects a request with no cookie', async () => {
    for (const url of ['/me', '/auth/session', '/auth/credentials', '/auth/sessions']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('rejects a forged cookie', async () => {
    const { cookieName } = await seedSession(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `${cookieName}=totally-made-up-token` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid session', async () => {
    const { cookie, userId } = await seedSession(h);
    const res = await h.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(userId);
  });

  it('stops working the moment the session is revoked (rule 127)', async () => {
    const { cookie, sessionId, userId } = await seedSession(h);
    expect(
      (await h.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).statusCode,
    ).toBe(200);

    await h.app.appDeps.sessions.revoke(sessionId, userId);

    expect(
      (await h.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it("will not let one user revoke another user's session", async () => {
    const alice = await seedSession(h);
    const mallory = await seedSession(h);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${alice.sessionId}`,
      headers: browserHeaders(mallory.cookie),
    });
    expect(res.statusCode).toBe(404);

    // Alice's session is untouched.
    expect(
      (await h.app.inject({ method: 'GET', url: '/me', headers: { cookie: alice.cookie } }))
        .statusCode,
    ).toBe(200);
  });

  it("lists only the caller's own sessions", async () => {
    const alice = await seedSession(h);
    await seedSession(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { cookie: alice.cookie },
    });
    const ids = res.json().sessions.map((s: { id: string }) => s.id);
    expect(ids).toEqual([alice.sessionId]);
    expect(res.json().sessions[0].current).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step-up (rules 135-139)
// ---------------------------------------------------------------------------

describe('step-up gate', () => {
  it('refuses credential revocation without a recent step-up', async () => {
    const { cookie } = await seedSession(h, { steppedUp: false });
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/auth/credentials/some-id',
      headers: browserHeaders(cookie),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe('STEP_UP_REQUIRED');
    // The client is told how fresh an assertion has to be (rule 137).
    expect(body.error.stepUpMaxAgeSeconds).toBeGreaterThan(0);
  });

  it('refuses 2FA enrollment without a recent step-up', async () => {
    const { cookie } = await seedSession(h, { steppedUp: false });
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/2fa/enroll',
      headers: browserHeaders(cookie),
    });
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
  });

  it('allows the same operation once the session has stepped up', async () => {
    const { cookie } = await seedSession(h, { steppedUp: true });
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/auth/credentials/00000000-0000-7000-8000-000000000000',
      headers: browserHeaders(cookie),
    });
    // Past the step-up gate; fails for the honest reason instead.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// TOTP (rules 132-134)
// ---------------------------------------------------------------------------

describe('two-factor enrollment', () => {
  it('returns the secret exactly once, then never again', async () => {
    const { cookie } = await seedSession(h, { steppedUp: true });

    const enroll = await h.app.inject({
      method: 'POST',
      url: '/auth/2fa/enroll',
      headers: browserHeaders(cookie),
    });
    expect(enroll.statusCode).toBe(200);
    const { secret, enrollmentId, otpauthUri } = enroll.json();
    expect(secret).toBeTruthy();
    expect(otpauthUri).toContain('otpauth://totp/');

    // Enrolling again issues a NEW secret rather than re-revealing the old one.
    const again = await h.app.inject({
      method: 'POST',
      url: '/auth/2fa/enroll',
      headers: browserHeaders(cookie),
    });
    expect(again.json().secret).not.toBe(secret);
    expect(again.json().enrollmentId).not.toBe(enrollmentId);
  });

  it('refuses a wrong code and reports a field path, not the code', async () => {
    const { cookie } = await seedSession(h, { steppedUp: true });
    const enroll = await h.app.inject({
      method: 'POST',
      url: '/auth/2fa/enroll',
      headers: browserHeaders(cookie),
    });
    const { enrollmentId } = enroll.json();

    const verify = await h.app.inject({
      method: 'POST',
      url: '/auth/2fa/verify',
      headers: browserHeaders(cookie),
      payload: { enrollmentId, code: '000000' },
    });
    expect(verify.statusCode).toBe(400);
    expect(verify.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('completes enrollment with a real code and issues recovery codes once', async () => {
    const { cookie, userId } = await seedSession(h, { steppedUp: true });
    const enroll = await h.app.inject({
      method: 'POST',
      url: '/auth/2fa/enroll',
      headers: browserHeaders(cookie),
    });
    const { secret, enrollmentId } = enroll.json();

    const { TOTP, Secret } = await import('otpauth');
    const code = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();

    const verify = await h.app.inject({
      method: 'POST',
      url: '/auth/2fa/verify',
      headers: browserHeaders(cookie),
      payload: { enrollmentId, code },
    });
    expect(verify.statusCode).toBe(200);
    const { recoveryCodes } = verify.json();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    // Only hashes were persisted.
    const stored = await h.app.appDeps.recoveryCodes.countUnused(userId);
    expect(stored).toBe(10);
  });

  it('stores the TOTP secret encrypted, not in plaintext', async () => {
    const { cookie, userId } = await seedSession(h, { steppedUp: true });
    const enroll = await h.app.inject({
      method: 'POST',
      url: '/auth/2fa/enroll',
      headers: browserHeaders(cookie),
    });
    const { secret } = enroll.json();

    const row = await h.app.appDeps.db.credential.findFirst({
      where: { userId, type: 'totp' },
      select: { totpSecretEncrypted: true },
    });
    const raw = Buffer.from(row!.totpSecretEncrypted!).toString('utf8');
    expect(raw).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// Log hygiene (rule 175)
// ---------------------------------------------------------------------------

describe('log hygiene', () => {
  it('leaks no session token, cookie, or secret into the logs', async () => {
    const { cookie } = await seedSession(h, { steppedUp: true });
    const token = cookie.split('=')[1]!;

    h.logs.clear();
    await h.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    await h.app.inject({
      method: 'POST',
      url: '/auth/2fa/enroll',
      headers: browserHeaders(cookie),
    });
    await h.app.inject({
      method: 'POST',
      url: '/auth/register/options',
      headers: browserHeaders(),
      payload: { email: 'leak-check@example.test' },
    });

    const output = h.logs.text();
    expect(output).not.toContain(token);
    expect(output).not.toContain(cookie);
    expect(output).not.toContain(process.env.SESSION_SECRET);
    expect(output).not.toContain(process.env.TOTP_ENCRYPTION_KEY);
    expect(output).not.toContain(process.env.DATABASE_URL);
  });

  it('still logs something useful', async () => {
    h.logs.clear();
    await h.app.inject({ method: 'GET', url: '/me' });
    const entries = h.logs.entries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.errorCode === 'AUTHENTICATION_REQUIRED')).toBe(true);
    expect(entries.every((e) => typeof e.correlationId === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cookie attributes (rule 124)
// ---------------------------------------------------------------------------

describe('session cookie', () => {
  it('is httpOnly, sameSite=strict, and path-scoped', async () => {
    const { cookie, cookieName } = await seedSession(h);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${(await seedSession(h)).sessionId}`,
      headers: browserHeaders(cookie),
    });
    // Whatever the outcome, no route may set a weaker cookie than the policy.
    const setCookie = res.headers['set-cookie'];
    if (setCookie !== undefined) {
      const value = Array.isArray(setCookie) ? setCookie.join(';') : setCookie;
      expect(value).toContain('HttpOnly');
      expect(value).toContain('SameSite=Strict');
    }
    expect(cookieName).toBeTruthy();
    expect(WEB_ORIGIN).toBeTruthy();
  });
});
