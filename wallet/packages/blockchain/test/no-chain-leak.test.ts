import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * prompt_phase2.md rules 98-99, 203.
 *
 * The lint rule stops this package IMPORTING a chain SDK. Nothing stops it
 * naming one — a `slot` field, a `lamports` type, a comment that says "for
 * Solana". Those leak the abstraction just as effectively and are invisible to
 * a dependency check, so they get their own test.
 */
const SRC = new URL('../src/', import.meta.url).pathname;

const FORBIDDEN = [
  'solana',
  'lamport',
  'ethereum',
  'bitcoin',
  'evm',
  'erc20',
  'spl',
  'satoshi',
  'gwei',
];

/** `slot` and `mint` are chain-specific concepts, not just chain names. */
const FORBIDDEN_IDENTIFIERS = ['slot', 'mint', 'blockhash', 'nonce'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('packages/blockchain names no chain', () => {
  const files = sourceFiles(SRC);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)('never mentions "%s"', (term) => {
    /**
     * WHOLE WORDS, not substrings.
     *
     * `includes('spl')` matches `split`, `splice` and `display`; `includes
     * ('evm')` would match nothing today but is the same class of trap. The
     * guard fired on `approvedBy.split('+')` in `custody.ts`, which names no
     * chain at all — a false positive that would have taught the next person
     * to work around the test rather than fix it, which is how a guard stops
     * guarding.
     */
    /**
     * Case-SENSITIVE, with the term's variants spelled out. Every part earns
     * its place:
     *
     *   \b            `display` contains `spl`, but not at a word start.
     *   variants      `spl`, `SPL`, `Spl` — the forms a leak actually takes.
     *   s?            `lamports` must still match; the plural is a word
     *                 character, so a plain `\b` on the right would miss it.
     *   (?![a-z])     `split` is `spl` + a lowercase continuation and is a
     *                 different word; `splToken` is `spl` + a camelCase
     *                 boundary and IS a leak.
     *
     * The `i` flag cannot be used here: under it `[a-z]` also matches
     * uppercase, so the lookahead would reject `splToken` too — which is how
     * this test was briefly blind to exactly the leak it exists to catch.
     */
    const variants = [term, term.toUpperCase(), term[0]?.toUpperCase() + term.slice(1)];
    const pattern = new RegExp(`\\b(?:${variants.join('|')})s?(?![a-z])`);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // The word may legitimately appear in a comment explaining the ban.
      const offending = content
        .split('\n')
        .filter((line) => pattern.test(line))
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
      expect(offending, `${file} mentions "${term}" outside a comment`).toEqual([]);
    }
  });

  it.each(FORBIDDEN_IDENTIFIERS)('never declares a "%s" binding or field', (identifier) => {
    // Fields, AND plain bindings: `const slot = 2` leaks the vocabulary just
    // as effectively as `readonly slot: number`, and was slipping through a
    // pattern that only looked for declarations with a type annotation.
    const pattern = new RegExp(
      `readonly\\s+${identifier}\\b` +
        `|\\b${identifier}\\s*[?]?\\s*:` +
        `|\\b(?:const|let|var|function)\\s+${identifier}\\b`,
      'i',
    );
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      expect(pattern.test(code), `${file} declares a "${identifier}" field`).toBe(false);
    }
  });
});
