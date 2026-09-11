import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseEnv, toApiConfig, toPublicConfig } from './index.js';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://wallet:wallet@localhost:5432/wallet',
  REDIS_URL: 'redis://localhost:6379',
  WEB_ORIGIN: 'http://localhost:3000',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'Wallet',
  WEBAUTHN_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: 'x'.repeat(32),
  TOTP_ENCRYPTION_KEY: 'y'.repeat(44),
  // Phase 2 (ADR-0004, ADR-0008).
  SOLANA_RPC_URL: 'http://127.0.0.1:8899',
  DEPOSIT_SEED: 'z'.repeat(44),
} as const;

describe('parseEnv', () => {
  it('accepts a complete environment and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.SESSION_COOKIE_NAME).toBe('wallet_session');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('names every missing variable (rule 60)', () => {
    let thrown: ConfigValidationError | undefined;
    try {
      parseEnv({ NODE_ENV: 'test' });
    } catch (e) {
      thrown = e as ConfigValidationError;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const named = thrown!.issues.map((i) => i.variable);
    for (const required of [
      'DATABASE_URL',
      'REDIS_URL',
      'WEB_ORIGIN',
      'WEBAUTHN_RP_ID',
      'WEBAUTHN_RP_NAME',
      'WEBAUTHN_ORIGIN',
      'SESSION_SECRET',
      'TOTP_ENCRYPTION_KEY',
      'SOLANA_RPC_URL',
      'DEPOSIT_SEED',
    ]) {
      expect(named).toContain(required);
    }
  });

  it('never prints a value in its report (rule 61)', () => {
    const leaky = { ...valid, SESSION_SECRET: 'short', DATABASE_URL: 'not-a-postgres-url' };
    let report = '';
    try {
      parseEnv(leaky);
    } catch (e) {
      report = (e as ConfigValidationError).report();
    }
    expect(report).toContain('SESSION_SECRET');
    expect(report).toContain('DATABASE_URL');
    expect(report).not.toContain('short');
    expect(report).not.toContain('not-a-postgres-url');
  });

  it('rejects an rpId that is not a suffix of the WebAuthn origin (rules 112-113)', () => {
    expect(() =>
      parseEnv({
        ...valid,
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ORIGIN: 'http://localhost:3000',
      }),
    ).toThrow(ConfigValidationError);

    // A registrable suffix is fine.
    expect(() =>
      parseEnv({
        ...valid,
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ORIGIN: 'https://app.example.com',
      }),
    ).not.toThrow();
  });

  it('rejects an idle TTL longer than the absolute TTL', () => {
    expect(() =>
      parseEnv({ ...valid, SESSION_IDLE_TTL_SECONDS: '100', SESSION_ABSOLUTE_TTL_SECONDS: '50' }),
    ).toThrow(ConfigValidationError);
  });

  it('requires https origins in production', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(ConfigValidationError);
  });

  it('refuses a sub-final commitment in production (ADR-0006)', () => {
    // Crediting below finality is a double-credit vector. A test environment
    // may loosen it; production may not.
    const productionish = {
      ...valid,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://app.example.com',
      WEBAUTHN_ORIGIN: 'https://app.example.com',
      WEBAUTHN_RP_ID: 'example.com',
      // A production config cannot use the mock signer either (ADR-0011), and
      // a `real` signer needs a client key to authenticate to services/mpc
      // (ADR-0013) — so this fixture would fail for two other reasons without
      // both of these.
      SIGNER_KIND: 'real',
      MPC_CLIENT_PRIVATE_KEY: 'ZmFrZS1wZW0tZm9yLXRlc3Rz',
    };
    expect(() => parseEnv({ ...productionish, SOLANA_COMMITMENT: 'finalized' })).not.toThrow();
    expect(() => parseEnv({ ...productionish, SOLANA_COMMITMENT: 'confirmed' })).toThrow(
      ConfigValidationError,
    );
  });

  it('refuses the mock signer in production (rules 125, 227)', () => {
    // Two independent guards: this, and MockSigner refusing to construct.
    // A mock signature verifies against nothing, so the failure would be
    // silent and expensive.
    const productionish = {
      ...valid,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://app.example.com',
      WEBAUTHN_ORIGIN: 'https://app.example.com',
      WEBAUTHN_RP_ID: 'example.com',
    };
    expect(() => parseEnv({ ...productionish, SIGNER_KIND: 'mock' })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects a risk limit that is not an integer base-unit string', () => {
    expect(() => parseEnv({ ...valid, RISK_DAILY_LIMIT: '1.5' })).toThrow(ConfigValidationError);
    expect(() => parseEnv({ ...valid, RISK_DAILY_LIMIT: '250000000000' })).not.toThrow();
  });

  it('refuses a real signer with no client key (ADR-0013)', () => {
    // It could not authenticate, so services/mpc would refuse every request.
    // Failing at boot beats failing at the first withdrawal.
    expect(() => parseEnv({ ...valid, SIGNER_KIND: 'real' })).toThrow(ConfigValidationError);
    expect(() =>
      parseEnv({ ...valid, SIGNER_KIND: 'real', MPC_CLIENT_PRIVATE_KEY: 'a-key' }),
    ).not.toThrow();
  });

  it('parses the asset allowlist (ADR-0008)', () => {
    expect(parseEnv(valid).SUPPORTED_ASSETS).toEqual(['SOL']);
    expect(parseEnv({ ...valid, SUPPORTED_ASSETS: 'SOL, USDC' }).SUPPORTED_ASSETS).toEqual([
      'SOL',
      'USDC',
    ]);
  });
});

describe('publicConfig', () => {
  it('carries no secret material (rule 64)', () => {
    const env = parseEnv(valid);
    const serialized = JSON.stringify(toPublicConfig(env));
    for (const secret of [
      env.SESSION_SECRET,
      env.TOTP_ENCRYPTION_KEY,
      env.DATABASE_URL,
      env.REDIS_URL,
      // The deposit seed can regenerate every deposit key (ADR-0005) and must
      // never reach the browser bundle.
      env.DEPOSIT_SEED,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('apiConfig', () => {
  it('is frozen so nothing can mutate configuration at runtime', () => {
    const cfg = toApiConfig(parseEnv(valid));
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.session)).toBe(true);
  });
});
