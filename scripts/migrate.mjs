/**
 * Database migration runner.
 *
 * Plain JavaScript on purpose: this file is the single implementation used by
 * the `npm run db:migrate` CLI, by the integration tests, and inside the
 * production container (which only installs production dependencies and cannot
 * run TypeScript or resolve the `@/` path alias).
 *
 * Migrations are ordered .sql files applied once each inside a transaction and
 * recorded in `schema_migrations`.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * @param {{ connectionString: string, dir?: string, ssl?: boolean, log?: (message: string) => void }} options
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function applyMigrations({ connectionString, dir = DEFAULT_DIR, ssl = false, log = () => {} }) {
  const client = new pg.Client({ connectionString, ssl: ssl ? { rejectUnauthorized: true } : undefined });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('select filename from schema_migrations');
    const already = new Set(rows.map((row) => row.filename));

    const applied = [];
    const skipped = [];

    for (const filename of files) {
      if (already.has(filename)) {
        skipped.push(filename);
        continue;
      }
      const sql = await readFile(path.join(dir, filename), 'utf8');
      // One transaction per migration: a failure leaves no partial schema.
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [filename]);
        await client.query('commit');
        applied.push(filename);
        log(`applied ${filename}`);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Migration ${filename} failed: ${error.message}`, { cause: error });
      }
    }

    return { applied, skipped };
  } finally {
    await client.end();
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const connectionString =
    process.env.DATABASE_MIGRATION_URL ??
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  const ssl = process.env.DATABASE_SSL === 'true';
  const { applied, skipped } = await applyMigrations({
    connectionString,
    ssl,
    log: (message) => console.log(`[migrate] ${message}`),
  });
  console.log(
    `[migrate] done — ${applied.length} applied, ${skipped.length} already up to date`,
  );
}
