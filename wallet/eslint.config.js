// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Architectural boundaries are enforced here rather than by convention.
 * prompt_phase1.md rules 57, 68, 89, 160, 186, 187, 188.
 *
 * `scripts/verify-boundaries.mjs` writes a deliberate violation of each rule
 * below and requires lint to reject it. Run it in CI — a boundary rule nobody
 * has watched fail is indistinguishable from one that is misconfigured.
 */

/** Applies everywhere outside @wallet/db. */
const SHARED_IMPORT_PATTERNS = [
  {
    group: ['@wallet/*/src/*', '@wallet/*/dist/*'],
    message:
      'Deep imports are banned. Import from the package barrel only (prompt_phase1.md rules 26-27).',
  },
  {
    group: ['@wallet/ledger', '@wallet/risk', '@wallet/blockchain', '@wallet/solana'],
    message: 'Phase 2+ package. Phase 1 must not depend on it (prompt_phase1.md rules 19-20).',
  },
  {
    group: ['@solana/*'],
    message: 'No chain dependencies in Phase 1 (prompt_phase1.md rule 21).',
  },
];

/** Additionally applies to packages/, which must stay framework-free. */
const PACKAGE_ONLY_IMPORT_PATTERNS = [
  {
    group: ['@wallet/api', '@wallet/web', '../../apps/*', '**/apps/*'],
    message:
      'A package must never import from an app. Dependencies point inward (prompt_phase1.md rule 143).',
  },
  {
    group: ['fastify', 'next', 'react'],
    message:
      'Framework imports do not belong in a domain package. Keep HTTP concerns out of domain logic (master-prompt rule 82).',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/generated/**',
      '**/*.config.js',
      '**/*.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // `null: 'ignore'` permits `x == null`, the idiomatic single check for
      // both null and undefined. Every other loose comparison stays an error.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // Rule 68: structured logging only.
          selector: "MemberExpression[object.name='console']",
          message:
            'console is banned. Use @wallet/logger — structured JSON only (prompt_phase1.md rule 68).',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Rule 56/57/186: process.env is read in exactly one file in the monorepo.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.ts', '**/*.tsx'],
    // The two files permitted to read the environment: one for the server,
    // one for the browser bundle. See apps/web/lib/config.ts for why Next.js
    // needs its own.
    ignores: ['packages/config/src/env.ts', 'apps/web/lib/config.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'process.env may only be read in packages/config/src/env.ts. Import validated config from @wallet/config instead (prompt_phase1.md rules 56-57).',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Rule 159/160/187: fetch lives only in the typed API client.
  // ---------------------------------------------------------------------------
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    ignores: ['apps/web/lib/api/**', 'apps/web/e2e/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'fetch may only be called from apps/web/lib/api/. Use the typed API client (prompt_phase1.md rules 159-160).',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'axios', message: 'HTTP calls belong in apps/web/lib/api/ (rule 160).' }],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Import boundaries.
  //
  // IMPORTANT: all of these live in ONE `no-restricted-imports` entry per file
  // scope. ESLint flat config REPLACES a rule's options when a later block
  // configures the same rule — it does not merge them. Splitting these across
  // two blocks silently disabled the first set for every file the second block
  // matched, and `scripts/verify-boundaries.mjs` is what caught it.
  //
  //   Rule 89     only @wallet/db may touch Prisma
  //   Rules 26-27 no deep imports across a package boundary
  //   Rules 19-21 no Phase 2+ packages, no chain dependencies
  //   Rule 143    a package never imports an app, or a framework
  // ---------------------------------------------------------------------------
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
    ignores: ['packages/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Only @wallet/db may import @prisma/client. Use a repository from @wallet/db (prompt_phase1.md rule 89).',
            },
          ],
          patterns: [...SHARED_IMPORT_PATTERNS],
        },
      ],
    },
  },

  {
    files: ['packages/**/*.ts'],
    ignores: ['packages/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message: 'Only @wallet/db may import @prisma/client (prompt_phase1.md rule 89).',
            },
          ],
          patterns: [...SHARED_IMPORT_PATTERNS, ...PACKAGE_ONLY_IMPORT_PATTERNS],
        },
      ],
    },
  },

  // Tests get more latitude.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**', '**/e2e/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
