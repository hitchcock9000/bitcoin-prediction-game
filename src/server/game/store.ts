import type { Pool } from 'pg';
import type { Direction, Outcome, PredictionStatus } from '@/domain/types';

/**
 * All SQL lives here, and only here. The service layer deals in plain objects;
 * the settlement logic deals in pure functions. Keeping this boundary sharp is
 * what makes the rules testable without a database and the SQL reviewable on
 * its own.
 */

export interface PlayerRecord {
  id: string;
  score: number;
  createdAt: Date;
}

export interface PredictionRecord {
  id: string;
  playerId: string;
  direction: Direction;
  entryPrice: string;
  entryPriceAt: Date;
  entryTradeId: number | null;
  priceSource: string;
  createdAt: Date;
  status: PredictionStatus;
  settlementPrice: string | null;
  settlementPriceAt: Date | null;
  resolvedAt: Date | null;
  outcome: Outcome | null;
}

/** Raised when the partial unique index rejects a second pending prediction. */
export class ActivePredictionExistsError extends Error {
  constructor() {
    super('Player already has a pending prediction');
    this.name = 'ActivePredictionExistsError';
  }
}

const PG_UNIQUE_VIOLATION = '23505';
const ONE_PENDING_CONSTRAINT = 'predictions_one_pending_per_player';

export interface CreatePredictionInput {
  playerId: string;
  direction: Direction;
  entryPrice: string;
  entryPriceAt: Date;
  entryTradeId: number | null;
  priceSource: string;
}

export interface SettlePredictionInput {
  predictionId: string;
  outcome: Outcome;
  settlementPrice: string;
  settlementPriceAt: Date;
}

export interface SettlementOutcome {
  /** False when another request had already settled it — not an error. */
  settled: boolean;
  newScore: number | null;
}

export function createGameStore(pool: Pool) {
  return {
    /**
     * Returns the player, creating them with a score of zero on first sight.
     *
     * One statement, and no write on the hot path once the player exists:
     * `on conflict do nothing` makes the insert a no-op, and the union falls
     * back to the existing row. This keeps a polling UI from generating write
     * traffic every few seconds.
     */
    async ensurePlayer(playerId: string): Promise<PlayerRecord> {
      const { rows } = await pool.query(
        `with inserted as (
           insert into players (id) values ($1)
           on conflict (id) do nothing
           returning id, score, created_at
         )
         select id, score, created_at from inserted
         union all
         select id, score, created_at from players where id = $1
         limit 1`,
        [playerId],
      );

      const row = rows[0];
      if (!row) throw new Error(`Failed to ensure player ${playerId}`);
      return mapPlayer(row);
    },

    async getActivePrediction(playerId: string): Promise<PredictionRecord | null> {
      const { rows } = await pool.query(
        `select * from predictions where player_id = $1 and status = 'pending' limit 1`,
        [playerId],
      );
      return rows[0] ? mapPrediction(rows[0]) : null;
    },

    /** Most recent prediction whatever its status — drives the result banner. */
    async getLatestPrediction(playerId: string): Promise<PredictionRecord | null> {
      const { rows } = await pool.query(
        `select * from predictions where player_id = $1 order by created_at desc limit 1`,
        [playerId],
      );
      return rows[0] ? mapPrediction(rows[0]) : null;
    },

    /**
     * Records a prediction.
     *
     * The caller has already obtained and validated the entry quote; this
     * method's job is to make the "one pending prediction per player" rule
     * hold under concurrency. It does not re-check for an existing pending
     * row, because a check-then-insert would race. Instead the partial unique
     * index is the guard, and a 23505 on that specific constraint is translated
     * into a domain error the API can map to HTTP 409.
     */
    async createPrediction(input: CreatePredictionInput): Promise<PredictionRecord> {
      try {
        const { rows } = await pool.query(
          `insert into predictions
             (player_id, direction, entry_price, entry_price_at, entry_trade_id, price_source)
           values ($1, $2, $3::numeric, $4::timestamptz, $5::bigint, $6)
           returning *`,
          [
            input.playerId,
            input.direction,
            input.entryPrice,
            input.entryPriceAt,
            input.entryTradeId,
            input.priceSource,
          ],
        );
        return mapPrediction(rows[0]);
      } catch (error) {
        if (isUniqueViolation(error, ONE_PENDING_CONSTRAINT)) {
          throw new ActivePredictionExistsError();
        }
        throw error;
      }
    },

    /**
     * Settles a prediction and moves the score **atomically, in one
     * statement**.
     *
     * This is the most important query in the project, and it is deliberately
     * structured so that double-scoring is impossible rather than unlikely:
     *
     * - The `settled` CTE only updates rows still in status 'pending'. Two
     *   concurrent settlement attempts therefore contend on the same row; the
     *   loser's UPDATE matches nothing and returns no rows.
     * - The `scored` CTE is driven by the rows the UPDATE actually returned.
     *   No rows returned means no score change. There is no window between
     *   "check status" and "add a point" for a second request to slip into.
     * - Because both CTEs execute inside one statement, they are one
     *   transaction: the status change and the score change commit together or
     *   not at all.
     *
     * `settled: false` is a normal outcome (a duplicate call, or the scheduler
     * and a request racing), not an error.
     */
    async settlePrediction(input: SettlePredictionInput): Promise<SettlementOutcome> {
      const { rows } = await pool.query(
        `with settled as (
           update predictions
              set status = 'resolved',
                  outcome = $2,
                  settlement_price = $3::numeric,
                  settlement_price_at = $4::timestamptz,
                  resolved_at = now()
            where id = $1
              and status = 'pending'
           returning player_id, outcome
         ),
         scored as (
           update players p
              set score = p.score + case when s.outcome = 'win' then 1 else -1 end
             from settled s
            where p.id = s.player_id
           returning p.score
         )
         select (select count(*) from settled)::int as settled_count,
                (select score from scored) as new_score`,
        [input.predictionId, input.outcome, input.settlementPrice, input.settlementPriceAt],
      );

      const row = rows[0] ?? { settled_count: 0, new_score: null };
      return {
        settled: row.settled_count === 1,
        newScore: row.new_score === null ? null : Number(row.new_score),
      };
    },

    /**
     * Pending predictions whose 60 seconds have elapsed.
     *
     * Both sides of the comparison are the database clock, which is the same
     * clock that `predictions_no_early_resolution` enforces and the same clock
     * that stamped `created_at`. Using the application's clock here would mean
     * the scheduler could select a row the CHECK constraint then rejects
     * (or worse, sit idle) purely because of drift between two machines.
     *
     * `dbNow` is returned so the caller can make the rest of the settlement
     * decision against that same clock reading.
     */
    async listSweepable(options: { waitSeconds: number; limit: number }): Promise<{
      candidates: PredictionRecord[];
      dbNow: Date | null;
    }> {
      const { rows } = await pool.query(
        `select now() as db_now, p.*
           from predictions p
          where p.status = 'pending'
            and p.created_at + make_interval(secs => $1) <= now()
          order by p.created_at asc
          limit $2`,
        [options.waitSeconds, options.limit],
      );

      if (rows.length === 0) {
        return { candidates: [], dbNow: null };
      }

      const dbNow = new Date(rows[0].db_now);
      return { candidates: rows.map(mapPrediction), dbNow };
    },
  };
}

export type GameStore = ReturnType<typeof createGameStore>;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION &&
    (error as { constraint?: string }).constraint === constraint
  );
}

function mapPlayer(row: Record<string, unknown>): PlayerRecord {
  return {
    id: String(row.id),
    score: Number(row.score),
    createdAt: asDate(row.created_at),
  };
}

function mapPrediction(row: Record<string, unknown>): PredictionRecord {
  return {
    id: String(row.id),
    playerId: String(row.player_id),
    direction: row.direction as Direction,
    // NUMERIC arrives as a string from pg, which is exactly what we want:
    // no float conversion anywhere between Postgres and the price comparison.
    entryPrice: String(row.entry_price),
    entryPriceAt: asDate(row.entry_price_at),
    entryTradeId: row.entry_trade_id === null ? null : Number(row.entry_trade_id),
    priceSource: String(row.price_source),
    createdAt: asDate(row.created_at),
    status: row.status as PredictionStatus,
    settlementPrice: row.settlement_price === null ? null : String(row.settlement_price),
    settlementPriceAt: row.settlement_price_at === null ? null : asDate(row.settlement_price_at),
    resolvedAt: row.resolved_at === null ? null : asDate(row.resolved_at),
    outcome: (row.outcome as Outcome | null) ?? null,
  };
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
