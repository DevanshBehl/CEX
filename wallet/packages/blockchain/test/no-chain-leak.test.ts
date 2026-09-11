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
    for (const file of files) {
      const content = readFileSync(file, 'utf8').toLowerCase();
      // The word may legitimately appear in a comment explaining the ban.
      const offending = content
        .split('\n')
        .filter((line) => line.includes(term))
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
      expect(offending, `${file} mentions "${term}" outside a comment`).toEqual([]);
    }
  });

  it.each(FORBIDDEN_IDENTIFIERS)('never declares a "%s" field', (identifier) => {
    const pattern = new RegExp(`readonly\\s+${identifier}\\b|\\b${identifier}\\s*[?]?\\s*:`, 'i');
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      expect(pattern.test(code), `${file} declares a "${identifier}" field`).toBe(false);
    }
  });
});
