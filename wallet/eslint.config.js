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

/**
 * Packages that do not exist yet. Importing one is a phase-ordering mistake,
 * and the error should say so rather than "cannot find module".
 *
 * This list is EMPTY as of Phase 3: @wallet/ledger, @wallet/blockchain and
 * @wallet/solana came off it when Phase 2 started, and @wallet/risk when
 * Phase 3 did. Phase 4's addition is `services/mpc`, which is Rust and so is
 * not reachable by a TypeScript import at all.
 *
 * Kept rather than deleted because the mechanism is the point: add a name here
 * the moment a future package is named, and add a case to
 * scripts/verify-boundaries.mjs alongside it.
 */
const FUTURE_PACKAGES = [];

/**
 * The domain packages that must stay free of chain, persistence, and framework
 * dependencies.
 *
 * `packages/ledger` is here because master-prompt rule 25 (dependency
 * inversion) and rule 196 (a second chain reuses the same ledger, risk and
 * custody abstractions) both depend on the accounting domain never learning
 * what a lamport is. `packages/risk` joins it in Phase 3.
 */
const CHAIN_FREE_PACKAGES = [
  'packages/ledger/**/*.ts',
  'packages/risk/**/*.ts',
  // Valuation is arithmetic over data it is handed. A price it fetched itself
  // would be a number nobody could reproduce from the inputs.
  'packages/portfolio/**/*.ts',
  // Order validation and hold computation take the reference price and the
  // market as arguments, for the same reason the risk engine takes `now` as an
  // argument: a decision that reads the world cannot be replayed (S1 §6).
  'packages/orders/**/*.ts',
];

/**
 * The only package allowed to import a Solana SDK (prompt_phase2.md rule 101).
 * Everything else depends on the @wallet/blockchain interfaces.
 */
const CHAIN_ADAPTER_PACKAGES = ['packages/solana/**/*.ts'];

/** Applies everywhere outside @wallet/db. */
const SHARED_IMPORT_PATTERNS = [
  {
    group: ['@wallet/*/src/*', '@wallet/*/dist/*'],
    message:
      'Deep imports are banned. Import from the package barrel only (prompt_phase1.md rules 26-27).',
  },
  // An empty group matches nothing, which is correct while the list is empty.
  ...(FUTURE_PACKAGES.length > 0
    ? [
        {
          group: FUTURE_PACKAGES,
          message:
            'That package belongs to a later phase and does not exist yet (prompt_phase2.md rule 30).',
        },
      ]
    : []),
];

/** Chain SDKs, banned everywhere except the adapter package. */
const CHAIN_SDK_PATTERN = {
  group: ['@solana/*', '@solana-program/*'],
  message:
    'Only packages/solana may import a chain SDK. Depend on the @wallet/blockchain interfaces instead (prompt_phase2.md rules 98-101).',
};

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

/** The accounting and risk domains additionally reject persistence. */
const DOMAIN_PURITY_PATTERN = {
  group: ['@wallet/db', '@wallet/solana', 'ioredis', '@prisma/*'],
  message:
    'The accounting and risk domains must not depend on a chain, a database, or a cache. They take data as arguments and return decisions (prompt_phase2.md rules 56-58).',
};

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
  // IMPORTANT: each file scope gets ONE `no-restricted-imports` entry. ESLint
  // flat config REPLACES a rule's options when a later block configures the
  // same rule for the same file — it does not merge them. Splitting these
  // across blocks silently disabled the first set, and
  // `scripts/verify-boundaries.mjs` is what caught it.
  // ---------------------------------------------------------------------------

  // Apps: no chain SDK, no Prisma, no future packages.
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
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
          patterns: [...SHARED_IMPORT_PATTERNS, CHAIN_SDK_PATTERN],
        },
      ],
    },
  },

  // Packages generally: also no frameworks and no reaching back into an app.
  {
    files: ['packages/**/*.ts'],
    ignores: ['packages/db/**', ...CHAIN_FREE_PACKAGES, ...CHAIN_ADAPTER_PACKAGES],
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
          patterns: [...SHARED_IMPORT_PATTERNS, ...PACKAGE_ONLY_IMPORT_PATTERNS, CHAIN_SDK_PATTERN],
        },
      ],
    },
  },

  // The chain adapter: may use the SDK, still may not use a framework or an app.
  {
    files: CHAIN_ADAPTER_PACKAGES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...SHARED_IMPORT_PATTERNS, ...PACKAGE_ONLY_IMPORT_PATTERNS],
        },
      ],
    },
  },

  // The accounting and risk domains: the strictest scope in the repo.
  {
    files: CHAIN_FREE_PACKAGES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...SHARED_IMPORT_PATTERNS,
            ...PACKAGE_ONLY_IMPORT_PATTERNS,
            CHAIN_SDK_PATTERN,
            DOMAIN_PURITY_PATTERN,
          ],
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
