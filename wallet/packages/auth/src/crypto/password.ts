import { hash, verify } from '@node-rs/argon2';

export interface Argon2Params {
  readonly memoryCostKib: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Returns whether the password matched, and whether the stored hash used
   *  outdated parameters and should be rewritten (rule 131). */
  verify(storedHash: string, password: string): Promise<{ valid: boolean; needsRehash: boolean }>;
}

/**
 * argon2id only (rule 131) — the hybrid variant, resistant to both GPU and
 * side-channel attack. Parameters come from config so they can be raised as
 * hardware improves without a code change, and `needsRehash` lets existing
 * hashes migrate on next successful login rather than in a batch job.
 */
export function createPasswordHasher(params: Argon2Params): PasswordHasher {
  // Algorithm.Argon2id === 2. The library exports it as an ambient `const
  // enum`, which `verbatimModuleSyntax` cannot import, so the value is inlined
  // here with the name it stands for rather than weakening the compiler flag
  // for the whole monorepo.
  const ARGON2ID = 2 as const;

  const options = {
    algorithm: ARGON2ID,
    memoryCost: params.memoryCostKib,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  };

  return {
    async hash(password) {
      return hash(password, options);
    },

    async verify(storedHash, password) {
      let valid = false;
      try {
        valid = await verify(storedHash, password, options);
      } catch {
        // A malformed stored hash is a failed verification, not a crash.
        return { valid: false, needsRehash: false };
      }
      if (!valid) return { valid: false, needsRehash: false };

      const needsRehash = !storedHash.includes(
        `m=${params.memoryCostKib},t=${params.timeCost},p=${params.parallelism}`,
      );
      return { valid: true, needsRehash };
    },
  };
}
