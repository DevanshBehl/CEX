/**
 * THE ONLY FILE IN THIS MONOREPO THAT READS process.env.
 *
 * prompt_phase1.md rules 56-57. Enforced by the `no-restricted-properties`
 * rule in eslint.config.js, which exempts exactly this path. If you need a new
 * setting, add it to the schema in ./schema.ts — do not read the environment
 * anywhere else.
 */

export type RawEnv = Readonly<Record<string, string | undefined>>;

export function readProcessEnv(): RawEnv {
  return Object.freeze({ ...process.env });
}
