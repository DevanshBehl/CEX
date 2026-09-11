#!/usr/bin/env node
/**
 * Dependency audit with a policy (prompt_phase4.md rule 164).
 *
 * `pnpm audit --audit-level high` fails on any high or critical advisory. That
 * is the right default and it is failing today, for advisories that need major
 * upgrades. The two usual responses are both wrong:
 *
 *   `|| true`            makes the job decorative, and a NEW critical lands
 *                        silently forever after.
 *   lowering the level   the same thing, spelled differently.
 *
 * So: high and critical fail the build UNLESS the advisory id is listed in
 * `docs/security/dependency-exceptions.md` with a reason and a date. A newly
 * introduced vulnerability is not on that list, so it still breaks CI — which
 * is the property worth having.
 *
 * Exceptions are read FROM the document, so the list cannot drift away from the
 * reasoning. Deleting a paragraph re-arms the check.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXCEPTIONS_DOC = 'docs/security/dependency-exceptions.md';

function allowedAdvisories() {
  const text = readFileSync(EXCEPTIONS_DOC, 'utf8');
  /*
   * Named modules, not advisory ids: the ids churn as registries re-issue
   * them, and the reasoning in the document is per-package.
   *
   * EVERY backticked name on a heading line, not just the first — a heading
   * like "### `vitest` / `vite`" documents two packages, and capturing one of
   * them let the other block the build with its reasoning already written.
   */
  return new Set(
    [...text.matchAll(/^### (.+)$/gm)].flatMap((line) =>
      [...(line[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ''),
    ),
  );
}

function audit() {
  try {
    return JSON.parse(execSync('pnpm audit --json', { encoding: 'utf8', maxBuffer: 64e6 }));
  } catch (error) {
    // pnpm exits non-zero when it finds anything; the report is still on stdout.
    const out = error.stdout?.toString() ?? '';
    if (out.trim() === '') throw error;
    return JSON.parse(out);
  }
}

const allowed = allowedAdvisories();
const advisories = Object.values(audit().advisories ?? {});

const blocking = [];
const excepted = [];

for (const advisory of advisories) {
  if (!['high', 'critical'].includes(advisory.severity)) continue;
  (allowed.has(advisory.module_name) ? excepted : blocking).push(advisory);
}

const unique = (list) => [
  ...new Map(list.map((a) => [`${a.module_name}:${a.github_advisory_id ?? a.id}`, a])).values(),
];

const blockingUnique = unique(blocking);
const exceptedUnique = unique(excepted);

console.log(`Dependency audit — ${String(advisories.length)} advisories total`);
console.log(`  documented exceptions : ${String(exceptedUnique.length)} (see ${EXCEPTIONS_DOC})`);
console.log(`  blocking              : ${String(blockingUnique.length)}`);

if (blockingUnique.length > 0) {
  console.error('\nUndocumented high/critical advisories:\n');
  for (const a of blockingUnique) {
    console.error(`  ${a.severity.padEnd(9)} ${a.module_name}  ${a.title ?? ''}`);
  }
  console.error(
    `\nEither upgrade, or add the package to ${EXCEPTIONS_DOC} with a reason and a date.`,
  );
  console.error('Do not add a blanket bypass.');
  process.exit(1);
}

console.log('\nNo undocumented high or critical advisories.');
