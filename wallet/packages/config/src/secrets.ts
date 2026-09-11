/**
 * Secret resolution (master-prompt rule 157, prompt_phase4.md rules 161-162).
 *
 * # The problem this solves
 *
 * Every secret in this system has lived in `.env`. That means each one is
 * readable by anything that can read the process environment or a core dump,
 * has no rotation path, no access record, and no expiry. The threat model
 * records it as a real gap, and the two values that matter most — the deposit
 * master seed, which regenerates every deposit key, and the key-encryption key
 * — are the ones that should move first.
 *
 * # The shape, and why it is an interface rather than an SDK
 *
 * A secret is named by a REFERENCE, not a value:
 *
 *   DEPOSIT_SEED=env:DEPOSIT_SEED_VALUE        development
 *   DEPOSIT_SEED=file:/run/secrets/deposit     a mounted secret
 *   DEPOSIT_SEED=aws:wallet/deposit-seed       a managed store
 *
 * A bare value with no scheme is still accepted, so an existing deployment is
 * unchanged by this shipping — but it is reported at boot, because "no scheme"
 * means "in the environment" and an operator should know that.
 *
 * Only `env` and `file` are implemented here. A cloud provider's SDK is a large
 * dependency and a deployment decision, and adding one speculatively would be
 * the empty-package trap: the resolver exists so that adding it later is a new
 * `SecretSource`, not a change to every call site.
 */

import { readFileSync } from 'node:fs';

export type SecretScheme = 'env' | 'file' | 'literal';

export interface ResolvedSecret {
  readonly value: string;
  readonly scheme: SecretScheme;
  /** The reference, with any secret VALUE removed. Safe to log. */
  readonly describe: string;
}

export class SecretResolutionError extends Error {
  constructor(
    readonly variable: string,
    reason: string,
  ) {
    // Never includes the reference's value, only its name and shape.
    super(`${variable}: ${reason}`);
    this.name = 'SecretResolutionError';
  }
}

/**
 * Resolve one reference.
 *
 * Throws rather than returning empty: a secret that silently resolves to `''`
 * produces a KEK of no bytes or a seed of no entropy, and the failure surfaces
 * much later as something that looks like corruption.
 */
export function resolveSecret(
  variable: string,
  reference: string,
  /**
   * The environment to resolve `env:` against.
   *
   * Passed in rather than read from `process.env`: this package's own lint
   * rule confines that global to one file, and it is right to — a second
   * module reaching for the environment is how configuration stops having a
   * single entry point. Passing it also makes the resolver testable without
   * mutating global state.
   */
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedSecret {
  const trimmed = reference.trim();
  if (trimmed === '') {
    throw new SecretResolutionError(variable, 'is empty');
  }

  const separator = trimmed.indexOf(':');
  const scheme = separator === -1 ? '' : trimmed.slice(0, separator);
  const rest = separator === -1 ? '' : trimmed.slice(separator + 1);

  switch (scheme) {
    case 'env': {
      const value = environment[rest];
      if (value === undefined || value.trim() === '') {
        throw new SecretResolutionError(variable, `env:${rest} is not set`);
      }
      return { value, scheme: 'env', describe: `env:${rest}` };
    }

    case 'file': {
      let contents: string;
      try {
        contents = readFileSync(rest, 'utf8');
      } catch {
        // The path is safe to name — it is configuration, not a secret — and
        // without it this error is unactionable.
        throw new SecretResolutionError(variable, `file:${rest} could not be read`);
      }
      // Trailing newline trimmed: every tool that writes a secret file adds
      // one, and a KEK with a newline is a different key.
      const value = contents.trim();
      if (value === '') {
        throw new SecretResolutionError(variable, `file:${rest} is empty`);
      }
      return { value, scheme: 'file', describe: `file:${rest}` };
    }

    default:
      // No recognised scheme: the value itself, in the environment. Supported
      // so nothing breaks, and reported so it is a decision rather than a
      // default nobody revisited.
      return { value: trimmed, scheme: 'literal', describe: `${variable} (literal)` };
  }
}

export interface SecretAudit {
  readonly variable: string;
  readonly scheme: SecretScheme;
  readonly describe: string;
}

/**
 * Resolve a set of secrets, reporting how each was obtained.
 *
 * The report carries NO values — only names and schemes — so it can be logged
 * at boot. That log is the thing that makes "we are still reading the deposit
 * seed from the environment" visible rather than assumed.
 */
export function resolveSecrets(
  references: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>>,
): {
  values: Record<string, string>;
  audit: SecretAudit[];
} {
  const values: Record<string, string> = {};
  const audit: SecretAudit[] = [];

  for (const [variable, reference] of Object.entries(references)) {
    const resolved = resolveSecret(variable, reference, environment);
    values[variable] = resolved.value;
    audit.push({ variable, scheme: resolved.scheme, describe: resolved.describe });
  }

  return { values, audit };
}

/**
 * The secrets that must not be literals in production (rule 162).
 *
 * These two can regenerate everything else: the deposit seed derives every
 * deposit key, and the KEK decrypts the treasury key at rest. Everything else
 * is a credential that can be rotated without reconstructing custody.
 */
export const CRITICAL_SECRETS = ['DEPOSIT_SEED', 'MPC_KEK'] as const;
