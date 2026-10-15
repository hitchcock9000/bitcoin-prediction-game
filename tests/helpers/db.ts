import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { applyMigrations } from '../../scripts/migrate.mjs';
import type { Direction } from '@/domain/types';

/**
 * Integration test plumbing.
 *
 * The tests run against a **real PostgreSQL server** rather than an in-memory
 * substitute, because the guarantees under test (partial unique index,
 * conditional UPDATE, CHECK constraints) *are* database behaviour. A fake would
 * let the suite pass while the real constraints were broken.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55432/bpg_test';

let sharedPool: Pool | null = null;

/** A fresh player id for tests that need an identity. */
export function newPlayerId(): string {
  return randomUUID();
}

export function testPool(): Pool {
  sharedPool ??= new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  return sharedPool;
}

/** Applies migrations. Idempotent, so test files can call it defensively. */
export async function migrateTestDatabase(): Promise<void> {
  await applyMigrations({ connectionString: TEST_DATABASE_URL });
}

/** Empties game tables between tests, keeping the schema. */
export async function resetDatabase(): Promise<void> {
  await testPool().query('truncate predictions, players restart identity cascade');
}

export async function closeTestDatabase(): Promise<void> {
  if (sharedPool) {
    const pool = sharedPool;
    sharedPool = null;
    await pool.end();
  }
}

export async function getScore(playerId: string): Promise<number | null> {
  const { rows } = await testPool().query('select score from players where id = $1', [playerId]);
  return rows[0] ? Number(rows[0].score) : null;
}

/**
 * Inserts a prediction whose window already elapsed.
 *
 * This deliberately bypasses the store: `created_at` is set by the database in
 * production, and the only sane way to test "60 seconds have passed" without
 * making the suite take minutes is to backdate the row. Production code has no
 * equivalent of this function — there is no API that writes a past
 * `created_at`.
 */
export async function insertBackdatedPrediction(options: {
  playerId: string;
  entryPrice: string;
  secondsAgo: number;
  direction?: Direction;
  entryTradeId?: number | null;
  priceSource?: string;
}): Promise<string> {
  const {
    playerId,
    entryPrice,
    secondsAgo,
    direction = 'up',
    entryTradeId = 1_000_000,
    priceSource = 'stub:BTC-USD',
  } = options;

  await testPool().query('insert into players (id) values ($1) on conflict (id) do nothing', [playerId]);

  const { rows } = await testPool().query(
    `insert into predictions
       (player_id, direction, entry_price, entry_price_at, entry_trade_id, price_source, created_at)
     values ($1, $2, $3::numeric,
             now() - make_interval(secs => $4::double precision),
             $5::bigint, $6,
             now() - make_interval(secs => $4::double precision))
     returning id`,
    [playerId, direction, entryPrice, secondsAgo, entryTradeId, priceSource],
  );

  return String(rows[0].id);
}

export async function readPrediction(id: string) {
  const { rows } = await testPool().query('select * from predictions where id = $1', [id]);
  return rows[0] as
    | {
        status: string;
        outcome: string | null;
        settlement_price: string | null;
        entry_price: string;
      }
    | undefined;
}
