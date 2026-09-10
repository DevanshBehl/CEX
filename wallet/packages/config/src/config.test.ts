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
