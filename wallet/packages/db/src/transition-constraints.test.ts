import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The generator's whole value is that it FAILS when the database and the
 * TypeScript table disagree. A check that only ever passes proves nothing, so
 * this tampers with a copy of the migrations and demands a failure.
 */
const SCRIPT = resolve(__dirname, '../scripts/check-transition-constraints.mjs');
const MIGRATIONS = resolve(__dirname, '../prisma/migrations');
const ORDERS = '20260922110000_orders/migration.sql';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function run(migrationsDir: string): { code: number; output: string } {
  try {
    const output = execFileSync('node', [SCRIPT], {
      env: { ...process.env, TRANSITIONS_MIGRATIONS_DIR: migrationsDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status: number; stderr: string; stdout: string };
    return { code: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

function tamperedCopy(edit: (sql: string) => string): string {
  dir = mkdtempSync(join(tmpdir(), 'transitions-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const file = join(dir, ORDERS);
  writeFileSync(file, edit(readFileSync(file, 'utf8')));
  return dir;
}

describe('check-transition-constraints', () => {
  it('passes on the real migrations', () => {
    expect(run(MIGRATIONS).code).toBe(0);
  });

  it('fails when a legal transition is removed from the database by hand', () => {
    const tampered = tamperedCopy((sql) => sql.replace("    ('PENDING_CANCEL', 'FILLED'),\n", ''));
    const { code, output } = run(tampered);
    expect(code).toBe(1);
    expect(output).toContain(
      'legal in TypeScript, refused by the database: PENDING_CANCEL->FILLED',
    );
  });

  it('fails when an illegal transition is added to the database by hand', () => {
    const tampered = tamperedCopy((sql) =>
      sql.replace("    ('OPEN', 'FILLED'),", "    ('OPEN', 'FILLED'),\n    ('FILLED', 'OPEN'),"),
    );
    const { code, output } = run(tampered);
    expect(code).toBe(1);
    expect(output).toContain('refused in TypeScript, allowed by the database: FILLED->OPEN');
  });
});
