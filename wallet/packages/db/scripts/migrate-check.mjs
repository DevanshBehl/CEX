#!/usr/bin/env node
/**
 * Do the checked-in migrations fully describe the schema? (rule 95)
 *
 * # Why this is a script and not one `prisma migrate diff` line
 *
 * `--shadow-database-url` is DESTRUCTIVE to whatever it points at: Prisma
 * replays every migration into that database and cleans up after itself,
 * which includes dropping `_prisma_migrations`.
 *
 * The previous version of this script passed `MIGRATION_DATABASE_URL` — the
 * real database. Run locally, it left a development database whose schema was
 * current but whose migration history was gone, so the next `migrate deploy`
 * refused to run with P3005. It was harmless in CI only because the database
 * there is thrown away a minute later.
 *
 * So: a dedicated shadow database, created and dropped here, and a refusal to
 * proceed if it would be the same database the application uses.
 */
import { execFileSync } from 'node:child_process';

const target = process.env.SHADOW_DATABASE_URL ?? deriveShadowUrl();

function deriveShadowUrl() {
  const base = process.env.MIGRATION_DATABASE_URL;
  if (!base) {
    console.error('\n  ✗ MIGRATION_DATABASE_URL or SHADOW_DATABASE_URL is required.\n');
    process.exit(2);
  }
  const url = new URL(base);
  // A sibling database on the same server, named so nobody mistakes it for
  // anything worth keeping.
  url.pathname = `${url.pathname.replace(/^\//, '')}_migrate_shadow`;
  return url.toString();
}

if (
  process.env.MIGRATION_DATABASE_URL !== undefined &&
  target === process.env.MIGRATION_DATABASE_URL
) {
  console.error(
    '\n  ✗ SHADOW_DATABASE_URL must not be the application database.\n' +
      '    Prisma replays migrations into it and drops its migration history.\n',
  );
  process.exit(2);
}

const shadow = new URL(target);
const shadowName = shadow.pathname.replace(/^\//, '');
const admin = new URL(target);
admin.pathname = '/postgres';

function psql(url, sql) {
  execFileSync('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

try {
  psql(admin, `DROP DATABASE IF EXISTS "${shadowName}"`);
  psql(admin, `CREATE DATABASE "${shadowName}"`);

  execFileSync(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'diff',
      '--from-migrations',
      './prisma/migrations',
      '--to-schema-datamodel',
      './prisma/schema.prisma',
      '--shadow-database-url',
      target,
      '--exit-code',
    ],
    { stdio: 'inherit' },
  );

  console.log('\n  ✓ the migrations describe the schema exactly\n');
} finally {
  try {
    psql(admin, `DROP DATABASE IF EXISTS "${shadowName}"`);
  } catch {
    // Leaving a shadow database behind is untidy, not a failure. Whatever went
    // wrong above is the thing worth reporting.
  }
}
