import { describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigValidationError,
  parseEnv,
  secretAudit,
  toApiConfig,
  toPublicConfig,
} from './index.js';

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

/**
 * A valid PRODUCTION environment.
 *
 * The critical secrets come from files because production refuses them as
 * literals (rule 162). Written once here rather than inline in each test: the
 * rule was added after these tests existed, and three copies of the fixture
 * would have been three places to forget it.
 */
function productionEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const seedPath = join(tmpdir(), `seed-${String(process.pid)}`);
  const kekPath = join(tmpdir(), `kek-${String(process.pid)}`);
  writeFileSync(seedPath, 'z'.repeat(44));
  writeFileSync(kekPath, Buffer.alloc(32, 4).toString('base64'));

  return {
    ...valid,
    NODE_ENV: 'production',
    WEB_ORIGIN: 'https://app.example.com',
    WEBAUTHN_ORIGIN: 'https://app.example.com',
    WEBAUTHN_RP_ID: 'example.com',
    // A production config cannot use the mock signer either (ADR-0011), and a
    // `real` signer needs a client key to authenticate to services/mpc
    // (ADR-0013) — so this fixture would fail for two other reasons without
    // both of these.
    SIGNER_KIND: 'real',
    MPC_CLIENT_PRIVATE_KEY: 'ZmFrZS1wZW0tZm9yLXRlc3Rz',
    DEPOSIT_SEED: `file:${seedPath}`,
    MPC_KEK: `file:${kekPath}`,
    ...overrides,
  };
}

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
    const productionish = productionEnv();
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

// ---------------------------------------------------------------------------
// The mint allowlist (ADR-0016, prompt_phase4.md rules 114, 124)
// ---------------------------------------------------------------------------

describe('TOKEN_MINTS', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

  it('defaults to no tokens, so an existing deployment is unchanged', () => {
    const config = toApiConfig(parseEnv(valid));
    expect(config.chain.assets.tokens).toEqual([]);
    // Cluster-qualified: the registry speaks ledger asset keys (ADR-0021).
    expect(config.chain.assets.keys).toEqual(['localnet:SOL']);
  });

  it('parses SYMBOL:MINT:DECIMALS and keys the registry on the mint', () => {
    const config = toApiConfig(
      parseEnv({ ...valid, TOKEN_MINTS: `USDC:${USDC}:6,USDT:${USDT}:6` }),
    );
    expect(config.chain.assets.keys).toEqual([
      'localnet:SOL',
      `localnet:${USDC}`,
      `localnet:${USDT}`,
    ]);
    expect(config.chain.assets.isAllowed(`localnet:${USDC}`)).toBe(true);
    // Neither the bare mint nor the same mint on another cluster.
    expect(config.chain.assets.isAllowed(USDC)).toBe(false);
    expect(config.chain.assets.isAllowed(`devnet:${USDC}`)).toBe(false);
    expect(config.chain.assets.isAllowed('localnet:USDC')).toBe(false);
  });

  it('rejects a mint that is not a base58 address', () => {
    expect(() => parseEnv({ ...valid, TOKEN_MINTS: 'USDC:not-an-address-0OIl:6' })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects an entry that is missing a field', () => {
    expect(() => parseEnv({ ...valid, TOKEN_MINTS: `USDC:${USDC}` })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects nonsense decimals', () => {
    expect(() => parseEnv({ ...valid, TOKEN_MINTS: `USDC:${USDC}:99` })).toThrow(
      ConfigValidationError,
    );
    expect(() => parseEnv({ ...valid, TOKEN_MINTS: `USDC:${USDC}:six` })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects the same mint listed twice', () => {
    // Two asset keys for one asset splits a user's balance in half silently.
    expect(() => parseEnv({ ...valid, TOKEN_MINTS: `USDC:${USDC}:6,USDC2:${USDC}:6` })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects two mints claiming the same symbol', () => {
    expect(() => parseEnv({ ...valid, TOKEN_MINTS: `USDC:${USDC}:6,usdc:${USDT}:6` })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects a mint that claims to be the native asset', () => {
    // This is the confusion the allowlist exists to prevent, so it must not be
    // expressible in the first place.
    expect(() => parseEnv({ ...valid, TOKEN_MINTS: `SOL:${USDC}:9` })).toThrow(
      ConfigValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Secret resolution (master-prompt rule 157, prompt_phase4.md rules 161-162)
// ---------------------------------------------------------------------------

describe('secret references', () => {
  it('accepts a literal, so an existing .env deployment is unchanged', () => {
    const config = parseEnv(valid);
    expect(config.DEPOSIT_SEED).toBe(valid.DEPOSIT_SEED);
  });

  it('resolves env: indirection', () => {
    // Resolved against the environment PASSED IN, not a global — which is why
    // this test needs no process.env mutation.
    const config = parseEnv({
      ...valid,
      SEED_FROM_ELSEWHERE: 'q'.repeat(44),
      DEPOSIT_SEED: 'env:SEED_FROM_ELSEWHERE',
    });
    expect(config.DEPOSIT_SEED).toBe('q'.repeat(44));
  });

  it('resolves file: indirection, trimming the trailing newline', () => {
    // Every tool that writes a secret file adds one, and a KEK with a newline
    // is a different key.
    const path = join(tmpdir(), `secret-${String(Date.now())}`);
    writeFileSync(path, `${'r'.repeat(44)}\n`);
    try {
      const config = parseEnv({ ...valid, DEPOSIT_SEED: `file:${path}` });
      expect(config.DEPOSIT_SEED).toBe('r'.repeat(44));
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('reports an unreadable file by NAME, never by content', () => {
    let message = '';
    try {
      parseEnv({ ...valid, DEPOSIT_SEED: 'file:/nonexistent/secret' });
    } catch (error) {
      message = (error as ConfigValidationError).report();
    }
    expect(message).toContain('DEPOSIT_SEED');
    expect(message).toContain('/nonexistent/secret');
  });

  it('refuses an env: reference that is not set, rather than resolving to empty', () => {
    // An empty secret produces a KEK of no bytes and fails much later as
    // something that looks like corruption.
    expect(() => parseEnv({ ...valid, DEPOSIT_SEED: 'env:DEFINITELY_NOT_SET' })).toThrow(
      ConfigValidationError,
    );
  });

  it('records how each secret was obtained, with no values', () => {
    parseEnv(valid);
    const audit = secretAudit();
    expect(audit.length).toBeGreaterThan(0);

    const rendered = JSON.stringify(audit);
    expect(rendered).not.toContain(valid.SESSION_SECRET);
    expect(rendered).not.toContain(valid.DEPOSIT_SEED);
  });

  it('REFUSES a literal deposit seed in production', () => {
    // Rule 162: the deposit seed can regenerate every deposit key, so it is
    // one of the two that must move to a secret manager first.
    const productionish = {
      ...valid,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://app.example.com',
      WEBAUTHN_ORIGIN: 'https://app.example.com',
      WEBAUTHN_RP_ID: 'example.com',
      SIGNER_KIND: 'real',
      MPC_CLIENT_PRIVATE_KEY: 'ZmFrZS1wZW0tZm9yLXRlc3Rz',
    };

    expect(() => parseEnv(productionish)).toThrow(ConfigValidationError);
  });

  it('accepts a production deposit seed that comes from a file', () => {
    const path = join(tmpdir(), `seed-${String(Date.now())}`);
    writeFileSync(path, 's'.repeat(44));
    try {
      const config = parseEnv({
        ...valid,
        NODE_ENV: 'production',
        WEB_ORIGIN: 'https://app.example.com',
        WEBAUTHN_ORIGIN: 'https://app.example.com',
        WEBAUTHN_RP_ID: 'example.com',
        SIGNER_KIND: 'real',
        MPC_CLIENT_PRIVATE_KEY: 'ZmFrZS1wZW0tZm9yLXRlc3Rz',
        DEPOSIT_SEED: `file:${path}`,
      });
      expect(config.DEPOSIT_SEED).toBe('s'.repeat(44));
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('leaves development alone — .env is the documented development path', () => {
    expect(() => parseEnv(valid)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Clusters (ADR-0021)
// ---------------------------------------------------------------------------

describe('cluster configuration (ADR-0021)', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const DEVNET_USDC = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

  it('serves only the default cluster unless told otherwise', () => {
    const config = toApiConfig(parseEnv(valid));
    expect(config.chain.clusters).toEqual(['localnet']);
    expect(config.chain.defaultCluster).toBe('localnet');
  });

  it('serves several clusters, each with its own endpoint', () => {
    const config = toApiConfig(
      parseEnv({
        ...valid,
        SOLANA_CLUSTERS: 'localnet,devnet',
        SOLANA_RPC_URL_DEVNET: 'https://api.devnet.solana.com',
      }),
    );

    expect(config.chain.clusters).toEqual(['localnet', 'devnet']);
    expect(config.chain.byCluster.devnet?.rpcUrl).toBe('https://api.devnet.solana.com');
    // The unsuffixed URL belongs to the default cluster and is not shared.
    expect(config.chain.byCluster.localnet?.rpcUrl).toBe('http://127.0.0.1:8899');
  });

  it('refuses to serve a cluster with no endpoint', () => {
    // Otherwise the cluster accepts requests and then cannot read a balance or
    // broadcast — an outage rather than a missing line of configuration.
    expect(() => parseEnv({ ...valid, SOLANA_CLUSTERS: 'localnet,mainnet-beta' })).toThrow(
      ConfigValidationError,
    );
  });

  it('refuses a cluster list that omits the default cluster', () => {
    expect(() =>
      parseEnv({
        ...valid,
        SOLANA_CLUSTERS: 'devnet',
        SOLANA_RPC_URL_DEVNET: 'https://api.devnet.solana.com',
      }),
    ).toThrow(ConfigValidationError);
  });

  it('does NOT inherit mints across clusters', () => {
    /*
     * The property that matters most here. A mint address means a different
     * token on a different cluster — inheriting `TOKEN_MINTS` would allowlist
     * whatever happens to live at the mainnet USDC address on devnet, and
     * credit a user for it.
     */
    const config = toApiConfig(
      parseEnv({
        ...valid,
        SOLANA_CLUSTERS: 'localnet,devnet',
        SOLANA_RPC_URL_DEVNET: 'https://api.devnet.solana.com',
        TOKEN_MINTS: `USDC:${USDC}:6`,
        TOKEN_MINTS_DEVNET: `USDC:${DEVNET_USDC}:6`,
      }),
    );

    expect(config.chain.byCluster.localnet?.assets.keys).toEqual([
      'localnet:SOL',
      `localnet:${USDC}`,
    ]);
    expect(config.chain.byCluster.devnet?.assets.keys).toEqual([
      'devnet:SOL',
      `devnet:${DEVNET_USDC}`,
    ]);
    // The mainnet mint is not allowlisted on devnet just because it is on the
    // other cluster's list.
    expect(config.chain.byCluster.devnet?.assets.isAllowed(`devnet:${USDC}`)).toBe(false);
  });

  it('leaves a non-default cluster with no tokens when it configures none', () => {
    const config = toApiConfig(
      parseEnv({
        ...valid,
        SOLANA_CLUSTERS: 'localnet,devnet',
        SOLANA_RPC_URL_DEVNET: 'https://api.devnet.solana.com',
        TOKEN_MINTS: `USDC:${USDC}:6`,
      }),
    );
    expect(config.chain.byCluster.devnet?.assets.keys).toEqual(['devnet:SOL']);
  });

  it('keys risk limits by cluster-qualified asset', () => {
    const config = toApiConfig(
      parseEnv({
        ...valid,
        SOLANA_CLUSTERS: 'localnet,devnet',
        SOLANA_RPC_URL_DEVNET: 'https://api.devnet.solana.com',
        RISK_ASSET_LIMITS: `${USDC}:1000:2000:500`,
        RISK_ASSET_LIMITS_DEVNET: `${DEVNET_USDC}:7000:8000:9000`,
      }),
    );

    expect(config.risk.assetLimits[`localnet:${USDC}`]?.perTransactionLimit).toBe('1000');
    expect(config.risk.assetLimits[`devnet:${DEVNET_USDC}`]?.perTransactionLimit).toBe('7000');
    // No bleed: the devnet list does not inherit the localnet mint's limit.
    expect(config.risk.assetLimits[`devnet:${USDC}`]).toBeUndefined();
    // Native limits apply on every served cluster.
    expect(config.risk.assetLimits['devnet:SOL']?.perTransactionLimit).toBeDefined();
    expect(config.risk.assetLimits['localnet:SOL']?.perTransactionLimit).toBeDefined();
  });

  it('does not offer a cluster it does not serve', () => {
    const config = toApiConfig(parseEnv(valid));
    expect(config.chain.byCluster['mainnet-beta']).toBeUndefined();
  });
});
