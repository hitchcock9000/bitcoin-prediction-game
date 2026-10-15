import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createGameStore } from '@/server/game/store';
import { createGameService } from '@/server/game/service';
import { runSettlementSweep } from '@/server/settlement/runner';
import { decimalsEqual } from '@/domain/decimal';
import type { PriceProvider } from '@/domain/types';
import {
  closeTestDatabase,
  getScore,
  insertBackdatedPrediction,
  newPlayerId,
  readPrediction,
  resetDatabase,
  testPool,
} from '../helpers/db';
import { failingProvider, fixedPrice, quoteAt, scriptedPrices, StubPriceProvider } from '../helpers/stubPriceProvider';

/**
 * End-to-end tests of the game loop against a real database: create a
 * prediction through the service, then drive settlement through the same sweep
 * the scheduler runs.
 *
 * Time is simulated by backdating `created_at` (see tests/helpers/db.ts) rather
 * than by waiting, so the 60-second rule is exercised exactly at its boundary
 * instead of approximately at 61 seconds of wall clock.
 */
function makeService(provider: PriceProvider) {
  const store = createGameStore(testPool());
  return { store, service: createGameService({ store, provider }) };
}

describe('game loop (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('starts a new player at zero and reports the live price', async () => {
    const provider = fixedPrice('82190.33');
    const { service } = makeService(provider);
    const playerId = newPlayerId();

    const state = await service.getPlayerState(playerId);
    expect(state.player.score).toBe(0);
    expect(state.activePrediction).toBeNull();
    expect(state.latestPrediction).toBeNull();

    const quote = await service.getMarketQuote();
    expect(quote.price).toBe('82190.33');
  });

  it('records the entry price from the server, not the caller', async () => {
    const provider = fixedPrice('82190.33');
    const { service } = makeService(provider);
    const playerId = newPlayerId();

    const { prediction, state } = await service.submitPrediction({ playerId, direction: 'up' });

    // Postgres returns NUMERIC at the declared scale ('82190.33000000'), so price
    // equality is asserted semantically rather than by string comparison.
    expect(decimalsEqual(prediction.entryPrice, '82190.33')).toBe(true);
    expect(prediction.status).toBe('pending');
    expect(prediction.direction).toBe('up');
    expect(prediction.priceSource).toBe('stub:BTC-USD');
    expect(state.activePrediction?.id).toBe(prediction.id);
    // created_at comes from the database clock, so it is always set.
    expect(prediction.createdAt).toBeInstanceOf(Date);
  });

  it('rejects a second prediction while one is open (rule 4)', async () => {
    const provider = fixedPrice('82190.33');
    const { service } = makeService(provider);
    const playerId = newPlayerId();

    await service.submitPrediction({ playerId, direction: 'up' });
    await expect(service.submitPrediction({ playerId, direction: 'down' })).rejects.toThrow(
      /already have an open prediction/i,
    );

    const { rows } = await testPool().query(
      `select count(*)::int as n from predictions where player_id = $1`,
      [playerId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('leaves a prediction open before the 60 second window has elapsed (rule 6)', async () => {
    const playerId = newPlayerId();
    await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 59 });
    const provider = fixedPrice('80500.00'); // price has "moved" plenty

    const result = await runSettlementSweep({ store: createGameStore(testPool()), provider });

    expect(result.examined).toBe(0);
    expect(result.settled).toBe(0);
    // Nothing was due, so the provider was not even called.
    expect((provider as StubPriceProvider).calls).toBe(0);

    const { rows } = await testPool().query(
      `select status from predictions where player_id = $1`,
      [playerId],
    );
    expect(rows[0].status).toBe('pending');
  });

  it.each([
    { direction: 'up' as const, entry: '80000.00', settlement: '80100.00', expected: 'win' },
    { direction: 'up' as const, entry: '80000.00', settlement: '79900.00', expected: 'loss' },
    { direction: 'down' as const, entry: '80000.00', settlement: '79900.00', expected: 'win' },
    { direction: 'down' as const, entry: '80000.00', settlement: '80100.00', expected: 'loss' },
  ])(
    'settles a $direction prediction against a $settlement price as a $expected (rules 7 and 8)',
    async ({ direction, entry, settlement, expected }) => {
      const playerId = newPlayerId();
      const predictionId = await insertBackdatedPrediction({
        playerId,
        entryPrice: entry,
        secondsAgo: 61,
        direction,
      });
      const provider = fixedPrice(settlement);

      const result = await runSettlementSweep({ store: createGameStore(testPool()), provider });

      expect(result.settled).toBe(1);
      const prediction = await readPrediction(predictionId);
      expect(prediction?.status).toBe('resolved');
      expect(prediction?.outcome).toBe(expected);
      expect(decimalsEqual(prediction?.settlement_price ?? '', settlement)).toBe(true);
      expect(await getScore(playerId)).toBe(expected === 'win' ? 1 : -1);
    },
  );

  it('keeps the prediction open while the price is unchanged (rule 6)', async () => {
    const playerId = newPlayerId();
    const predictionId = await insertBackdatedPrediction({
      playerId,
      entryPrice: '80000.00',
      secondsAgo: 61,
    });
    const provider = fixedPrice('80000.00'); // identical price, fresh timestamp

    const result = await runSettlementSweep({ store: createGameStore(testPool()), provider });

    expect(result.examined).toBe(1);
    expect(result.settled).toBe(0);
    expect(result.decisions[0]?.reason).toBe('price_unchanged');
    expect((await readPrediction(predictionId))?.status).toBe('pending');
    expect(await getScore(playerId)).toBe(0);
  });

  it('settles on a later sweep once the price finally moves', async () => {
    const playerId = newPlayerId();
    const predictionId = await insertBackdatedPrediction({
      playerId,
      entryPrice: '80000.00',
      secondsAgo: 61,
    });
    // First sweep: unchanged. Second sweep: moved.
    const provider = scriptedPrices('80000.00', '80025.00');
    const store = createGameStore(testPool());

    const first = await runSettlementSweep({ store, provider });
    expect(first.settled).toBe(0);
    expect((await readPrediction(predictionId))?.status).toBe('pending');

    const second = await runSettlementSweep({ store, provider });
    expect(second.settled).toBe(1);
    const prediction = await readPrediction(predictionId);
    expect(prediction?.outcome).toBe('win');
    expect(decimalsEqual(prediction?.settlement_price ?? '', '80025.00')).toBe(true);
    expect(await getScore(playerId)).toBe(1);
  });

  it('never produces an outcome when the price feed is down (rule: no fabricated results)', async () => {
    const playerId = newPlayerId();
    const predictionId = await insertBackdatedPrediction({
      playerId,
      entryPrice: '80000.00',
      secondsAgo: 61,
    });

    const result = await runSettlementSweep({
      store: createGameStore(testPool()),
      provider: failingProvider(),
    });

    expect(result.providerAvailable).toBe(false);
    expect(result.settled).toBe(0);
    expect(result.decisions[0]?.reason).toBe('provider_unavailable');
    expect((await readPrediction(predictionId))?.status).toBe('pending');
    expect(await getScore(playerId)).toBe(0);
  });

  it('refuses to settle on a stale quote', async () => {
    const playerId = newPlayerId();
    const predictionId = await insertBackdatedPrediction({
      playerId,
      entryPrice: '80000.00',
      secondsAgo: 61,
    });
    // A provider serving a quote that is minutes old (cached or hung response).
    const provider = new StubPriceProvider(() =>
      quoteAt('80100.00', new Date(Date.now() - 5 * 60_000), 1_000_100),
    );

    const result = await runSettlementSweep({ store: createGameStore(testPool()), provider });

    expect(result.settled).toBe(0);
    expect(result.decisions[0]?.reason).toBe('stale_quote');
    expect((await readPrediction(predictionId))?.status).toBe('pending');
  });

  it('scores a concurrent double sweep exactly once', async () => {
    const playerId = newPlayerId();
    await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 61 });
    const provider = fixedPrice('80100.00');

    // Two sweeps racing — the shape of two scheduler instances, or a scheduler
    // tick overlapping with an external cron hitting /api/settle.
    const [a, b] = await Promise.all([
      runSettlementSweep({ store: createGameStore(testPool()), provider }),
      runSettlementSweep({ store: createGameStore(testPool()), provider }),
    ]);

    expect(a.settled + b.settled).toBe(1);
    expect(await getScore(playerId)).toBe(1);
  });

  it('uses one shared quote for every prediction in a sweep', async () => {
    const players = [newPlayerId(), newPlayerId()];
    for (const playerId of players) {
      await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 61 });
    }
    const provider = fixedPrice('80100.00');

    const result = await runSettlementSweep({ store: createGameStore(testPool()), provider });

    expect(result.examined).toBe(2);
    expect(result.settled).toBe(2);
    // One market observation scored both predictions, so two players who came
    // due in the same tick cannot be judged against different prices.
    expect((provider as StubPriceProvider).calls).toBe(1);
    for (const playerId of players) {
      expect(await getScore(playerId)).toBe(1);
    }
  });

  it('picks up predictions that came due while the server was down (restart recovery)', async () => {
    // Simulate the downtime: a prediction is created, the process goes away
    // before its window elapses, and a completely fresh set of objects is built
    // afterwards. Nothing is carried over in memory — the work is discovered
    // from the database, which is what makes restarts safe.
    const playerId = newPlayerId();
    const predictionId = await insertBackdatedPrediction({
      playerId,
      entryPrice: '80000.00',
      secondsAgo: 61,
    });

    const restartedStore = createGameStore(testPool());
    const result = await runSettlementSweep({ store: restartedStore, provider: fixedPrice('80150.00') });

    expect(result.settled).toBe(1);
    expect((await readPrediction(predictionId))?.status).toBe('resolved');
    expect(await getScore(playerId)).toBe(1);

    // And the player's state, rebuilt from the database alone, reflects it.
    const { service } = makeService(fixedPrice('80150.00'));
    const state = await service.getPlayerState(playerId);
    expect(state.player.score).toBe(1);
    expect(state.activePrediction).toBeNull();
    expect(state.latestPrediction?.outcome).toBe('win');
  });

  it('retains score and the open prediction for a returning player (optional requirement)', async () => {
    const first = makeService(fixedPrice('80000.00'));
    const playerId = newPlayerId();

    const created = await first.service.submitPrediction({ playerId, direction: 'up' });
    await testPool().query('update players set score = 4 where id = $1', [playerId]);

    // "Returning" = a brand-new service instance, as after a redeploy, with the
    // only link back being the player id from the signed cookie.
    const second = makeService(fixedPrice('80000.00'));
    const state = await second.service.getPlayerState(playerId);

    expect(state.player.score).toBe(4);
    expect(state.activePrediction?.id).toBe(created.prediction.id);
    expect(state.activePrediction?.direction).toBe('up');
    expect(decimalsEqual(state.activePrediction?.entryPrice ?? '', '80000.00')).toBe(true);
  });
});
