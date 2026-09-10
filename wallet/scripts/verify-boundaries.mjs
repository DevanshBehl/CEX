#!/usr/bin/env node
/**
 * Proves the architectural lint rules actually fail (prompt_phase1.md rule 188).
 *
 * A boundary rule nobody has ever seen reject anything is indistinguishable
 * from a boundary rule that is misconfigured and silently passing everything.
 * So: write a deliberate violation, require lint to fail, then delete it.
 *
 * Phase 2 adds a case here for "packages/ledger must not import
 * packages/solana", which is the rule that actually protects the architecture.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CASES = [
  {
    name: 'process.env outside @wallet/config',
    file: 'packages/logger/src/__boundary_probe.ts',
    source: 'export const leak = process.env.SESSION_SECRET;\n',
    expect: /process\.env may only be read/,
  },
  {
    name: 'deep import across a package boundary',
    file: 'packages/errors/src/__boundary_probe.ts',
    source: "import '@wallet/types/src/brands.js';\n",
    expect: /Deep imports are banned/,
  },
  {
    name: 'a package importing a framework',
    file: 'packages/auth/src/__boundary_probe.ts',
    source: "import 'fastify';\n",
    expect: /do not belong in a domain package/,
  },
  {
    name: 'a Phase 2 package referenced from Phase 1',
    file: 'packages/auth/src/__boundary_probe2.ts',
    source: "import '@wallet/ledger';\n",
    expect: /Phase 2\+ package/,
  },
  {
    name: 'fetch outside the typed API client',
    file: 'apps/web/features/auth/__boundary_probe.ts',
    source: 'export const bad = () => fetch("/anything");\n',
    expect: /may only be called from apps\/web\/lib\/api/,
  },
  {
    name: 'Prisma imported outside @wallet/db',
    file: 'apps/api/src/__boundary_probe.ts',
    source: "import '@prisma/client';\n",
    expect: /Only @wallet\/db may import @prisma\/client/,
  },
];

let failures = 0;

for (const testCase of CASES) {
  mkdirSync(dirname(testCase.file), { recursive: true });
  writeFileSync(testCase.file, testCase.source);

  let output = '';
  let linted = true;
  try {
    execFileSync('pnpm', ['exec', 'eslint', testCase.file], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    linted = false;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  } finally {
    rmSync(testCase.file, { force: true });
  }

  if (linted) {
    console.error(`✗ ${testCase.name}: lint PASSED a violation it should have rejected`);
    failures += 1;
  } else if (!testCase.expect.test(output)) {
    console.error(`✗ ${testCase.name}: lint failed, but not for the expected reason`);
    console.error(output.split('\n').slice(0, 8).join('\n'));
    failures += 1;
  } else {
    console.log(`✓ ${testCase.name}: correctly rejected`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} boundary rule(s) are not enforcing what they claim.`);
  process.exit(1);
}
console.log('\nAll architectural boundaries are enforced.');
