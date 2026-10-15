import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivePredictionExistsError, createGameStore } from '@/server/game/store';
import {
  closeTestDatabase,
  getScore,
  insertBackdatedPrediction,
  newPlayerId,
  readPrediction,
  resetDatabase,
  testPool,
} from '../helpers/db';

/**
 * Store-level tests: the invariants the *database* enforces.
 *
 * These are the guarantees that hold even if a future caller bypasses the
 * service layer, so they are worth testing directly rather than only through
 * the happy path.
 *
 * There is deliberately no "skip if no database" escape hatch here. If the
 * database is missing the suite fails loudly rather than reporting green while
 * the guarantees went unverified.
 */
describe('game store (real PostgreSQL)', () => {
  const store = createGameStore(testPool());

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  describe('players', () => {
    it('creates a new player with a score of zero', async () => {
      const playerId = newPlayerId();
      const player = await store.ensurePlayer(playerId);
      expect(player.id).toBe(playerId);
      expect(player.score).toBe(0);
    });

    it('does not reset an existing player', async () => {
      const playerId = newPlayerId();
      await store.ensurePlayer(playerId);
      await testPool().query('update players set score = 7 where id = $1', [playerId]);
      const player = await store.ensurePlayer(playerId);
      expect(player.score).toBe(7);
    });

    it('is idempotent under concurrent first requests', async () => {
      const playerId = newPlayerId();
      const results = await Promise.all(Array.from({ length: 10 }, () => store.ensurePlayer(playerId)));
      for (const player of results) {
        expect(player.id).toBe(playerId);
        expect(player.score).toBe(0);
      }
      const { rows } = await testPool().query('select count(*)::int as n from players');
      expect(rows[0].n).toBe(1);
    });
  });

  describe('one pending prediction per player (business rule 4)', () => {
    const baseInput = (playerId: string) => ({
      playerId,
      entryPrice: '80000.00',
      entryPriceAt: new Date(),
      priceSource: 'stub:BTC-USD',
    });

    it('rejects a second pending prediction', async () => {
      const playerId = newPlayerId();
      await store.ensurePlayer(playerId);
      await store.createPrediction({ ...baseInput(playerId), direction: 'up', entryTradeId: 1 });

      await expect(
        store.createPrediction({ ...baseInput(playerId), direction: 'down', entryTradeId: 2 }),
      ).rejects.toBeInstanceOf(ActivePredictionExistsError);
    });

    it('allows a new prediction once the previous one is resolved', async () => {
      const playerId = newPlayerId();
      await store.ensurePlayer(playerId);
      const first = await store.createPrediction({ ...baseInput(playerId), direction: 'up', entryTradeId: 1 });

      await testPool().query(
        `update predictions
            set status = 'resolved',
                outcome = 'win',
                settlement_price = 80001,
                settlement_price_at = entry_price_at + interval '61 seconds',
                resolved_at = created_at + interval '61 seconds'
          where id = $1`,
        [first.id],
      );

      const second = await store.createPrediction({ ...baseInput(playerId), direction: 'down', entryTradeId: 5 });
      expect(second.status).toBe('pending');
      expect(second.direction).toBe('down');
    });

    it('lets exactly one of 20 concurrent creations win', async () => {
      // The same shape of experiment run by hand during design (DECISIONS.md
      // D1): a "select then insert" guard lets several of these through.
      const playerId = newPlayerId();
      await store.ensurePlayer(playerId);

      const attempts = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) =>
          store.createPrediction({
            ...baseInput(playerId),
            direction: index % 2 === 0 ? 'up' : 'down',
            entryTradeId: index,
          }),
        ),
      );

      const created = attempts.filter((attempt) => attempt.status === 'fulfilled');
      const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
      expect(created).toHaveLength(1);
      expect(rejected).toHaveLength(19);
      for (const rejection of rejected) {
        expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(ActivePredictionExistsError);
      }

      const { rows } = await testPool().query(
        `select count(*)::int as n from predictions where player_id = $1 and status = 'pending'`,
        [playerId],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('settlement is applied exactly once (business rules 7 and 8)', () => {
    it('ignores a repeated settlement of the same prediction', async () => {
      const playerId = newPlayerId();
      const predictionId = await insertBackdatedPrediction({
        playerId,
        entryPrice: '80000.00',
        secondsAgo: 61,
      });

      const first = await store.settlePrediction({
        predictionId,
        outcome: 'win',
        settlementPrice: '80100.00',
        settlementPriceAt: new Date(),
      });
      const second = await store.settlePrediction({
        predictionId,
        outcome: 'win',
        settlementPrice: '80100.00',
        settlementPriceAt: new Date(),
      });

      expect(first.settled).toBe(true);
      expect(first.newScore).toBe(1);
      expect(second.settled).toBe(false);
      expect(second.newScore).toBeNull();
      expect(await getScore(playerId)).toBe(1);
    });

    it('ignores concurrent settlement attempts', async () => {
      const playerId = newPlayerId();
      const predictionId = await insertBackdatedPrediction({
        playerId,
        entryPrice: '80000.00',
        secondsAgo: 61,
      });

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.settlePrediction({
            predictionId,
            outcome: 'win',
            settlementPrice: '80100.00',
            settlementPriceAt: new Date(),
          }),
        ),
      );

      expect(results.filter((result) => result.settled)).toHaveLength(1);
      expect(await getScore(playerId)).toBe(1);

      const prediction = await readPrediction(predictionId);
      expect(prediction?.status).toBe('resolved');
      expect(prediction?.outcome).toBe('win');
    });

    it('accumulates points across several rounds', async () => {
      const playerId = newPlayerId();

      // Three wins, then two losses. Each round is a new prediction, which the
      // partial unique index permits precisely because the previous one is no
      // longer pending.
      for (const price of ['80100.00', '80200.00', '80300.00']) {
        const id = await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 61 });
        const result = await store.settlePrediction({
          predictionId: id,
          outcome: 'win',
          settlementPrice: price,
          settlementPriceAt: new Date(),
        });
        expect(result.settled).toBe(true);
      }
      expect(await getScore(playerId)).toBe(3);

      for (const price of ['79900.00', '79800.00']) {
        const id = await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 61 });
        const result = await store.settlePrediction({
          predictionId: id,
          outcome: 'loss',
          settlementPrice: price,
          settlementPriceAt: new Date(),
        });
        expect(result.settled).toBe(true);
      }
      expect(await getScore(playerId)).toBe(1);
    });
  });

  describe('database constraints (defence in depth)', () => {
    it('refuses to resolve a prediction before 60 seconds have elapsed', async () => {
      const playerId = newPlayerId();
      const predictionId = await insertBackdatedPrediction({
        playerId,
        entryPrice: '80000.00',
        secondsAgo: 10,
      });

      // Bypasses the entire settlement policy and writes the row directly: the
      // CHECK constraint must still reject it.
      await expect(
        testPool().query(
          `update predictions
              set status = 'resolved', outcome = 'win',
                  settlement_price = 80100, settlement_price_at = now(),
                  resolved_at = created_at + interval '10 seconds'
            where id = $1`,
          [predictionId],
        ),
      ).rejects.toThrow(/predictions_no_early_resolution/);
    });

    it('refuses an outcome that contradicts the price movement', async () => {
      const playerId = newPlayerId();
      const predictionId = await insertBackdatedPrediction({
        playerId,
        entryPrice: '80000.00',
        secondsAgo: 61,
        direction: 'up',
      });

      await expect(
        testPool().query(
          `update predictions
              set status = 'resolved', outcome = 'win',
                  settlement_price = 79999, settlement_price_at = now(),
                  resolved_at = now()
            where id = $1`,
          [predictionId],
        ),
      ).rejects.toThrow(/predictions_outcome_matches_price_movement/);
    });

    it('refuses to score an unchanged price as a loss', async () => {
      // The near-miss that the biconditional alone would have allowed:
      // outcome 'loss' together with (entry > entry) === false.
      const playerId = newPlayerId();
      const predictionId = await insertBackdatedPrediction({
        playerId,
        entryPrice: '80000.00',
        secondsAgo: 61,
        direction: 'up',
      });

      await expect(
        testPool().query(
          `update predictions
              set status = 'resolved', outcome = 'loss',
                  settlement_price = 80000, settlement_price_at = now(),
                  resolved_at = now()
            where id = $1`,
          [predictionId],
        ),
      ).rejects.toThrow(/predictions_outcome_matches_price_movement/);
    });

    it('refuses a resolved row with missing settlement data', async () => {
      const playerId = newPlayerId();
      const predictionId = await insertBackdatedPrediction({
        playerId,
        entryPrice: '80000.00',
        secondsAgo: 61,
      });

      await expect(
        testPool().query(
          `update predictions set status = 'resolved', outcome = 'win', resolved_at = now() where id = $1`,
          [predictionId],
        ),
      ).rejects.toThrow(/predictions_settlement_completeness/);
    });

    it('refuses an invalid direction', async () => {
      const playerId = newPlayerId();
      await testPool().query('insert into players (id) values ($1)', [playerId]);

      await expect(
        testPool().query(
          `insert into predictions (player_id, direction, entry_price, entry_price_at, price_source)
           values ($1, 'sideways', 80000, now(), 'test')`,
          [playerId],
        ),
      ).rejects.toThrow(/predictions_direction_check/);
    });
  });

  describe('sweep selection', () => {
    it('selects only predictions whose window has elapsed', async () => {
      const duePlayer = newPlayerId();
      await insertBackdatedPrediction({ playerId: duePlayer, entryPrice: '80000.00', secondsAgo: 61 });
      const waitingPlayer = newPlayerId();
      await insertBackdatedPrediction({ playerId: waitingPlayer, entryPrice: '80000.00', secondsAgo: 30 });

      const { candidates, dbNow } = await store.listSweepable({ waitSeconds: 60, limit: 25 });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.playerId).toBe(duePlayer);
      expect(dbNow).toBeInstanceOf(Date);
    });

    it('returns nothing when no prediction is due', async () => {
      const playerId = newPlayerId();
      await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 1 });
      const { candidates } = await store.listSweepable({ waitSeconds: 60, limit: 25 });
      expect(candidates).toHaveLength(0);
    });
  });
});
