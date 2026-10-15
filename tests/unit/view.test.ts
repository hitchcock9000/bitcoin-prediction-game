import { describe, expect, it } from 'vitest';
import { RULES } from '@/domain/rules';
import { toActivePredictionView, toLatestPredictionView, toMarketView } from '@/server/http/view';
import type { PredictionRecord } from '@/server/game/store';

/**
 * The view layer is the last thing that touches a value before the browser
 * renders it, so these tests pin the two things that have bitten before:
 * NUMERIC's declared scale, and the countdown's arithmetic.
 */
const CREATED_AT = new Date('2026-10-15T12:00:00.000Z');

function prediction(overrides: Partial<PredictionRecord> = {}): PredictionRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    playerId: '22222222-2222-4222-8222-222222222222',
    direction: 'up',
    entryPrice: '80000.00000000',
    entryPriceAt: CREATED_AT,
    entryTradeId: 1,
    priceSource: 'test',
    createdAt: CREATED_AT,
    status: 'pending',
    settlementPrice: null,
    settlementPriceAt: null,
    resolvedAt: null,
    outcome: null,
    ...overrides,
  };
}

describe('toActivePredictionView', () => {
  it('normalises the scale Postgres returns for prices', () => {
    const view = toActivePredictionView(prediction(), CREATED_AT, 'waiting');
    expect(view.entryPrice).toBe('80000.00');
  });

  it('never reports more than the configured wait', () => {
    // Regression: the handler's clock is read before the row is inserted, so
    // the deadline can appear fractionally more than 60s away.
    const justBeforeInsert = new Date(CREATED_AT.getTime() - 5);
    const view = toActivePredictionView(prediction(), justBeforeInsert, 'waiting');
    expect(view.secondsRemaining).toBe(RULES.minWaitMs / 1000);
  });

  it('counts down as the deadline approaches', () => {
    const view = toActivePredictionView(prediction(), new Date(CREATED_AT.getTime() + 47_500), 'waiting');
    expect(view.secondsRemaining).toBe(13);
  });

  it('reports zero once the window has elapsed, never a negative number', () => {
    const view = toActivePredictionView(prediction(), new Date(CREATED_AT.getTime() + 250_000), 'waiting');
    expect(view.secondsRemaining).toBe(0);
  });

  it('exposes the deadline so a client can render progress', () => {
    const view = toActivePredictionView(prediction(), CREATED_AT, 'waiting');
    expect(view.deadlineAt).toBe('2026-10-15T12:01:00.000Z');
  });
});

describe('toLatestPredictionView', () => {
  it('reports a resolved win with its score delta', () => {
    const view = toLatestPredictionView(
      prediction({
        status: 'resolved',
        outcome: 'win',
        settlementPrice: '80200.50000000',
        settlementPriceAt: new Date('2026-10-15T12:01:05.000Z'),
        resolvedAt: new Date('2026-10-15T12:01:06.000Z'),
      }),
    );
    expect(view.status).toBe('resolved');
    expect(view.outcome).toBe('win');
    expect(view.scoreDelta).toBe(1);
    expect(view.settlementPrice).toBe('80200.50');
    expect(view.resolvedAt).toBe('2026-10-15T12:01:06.000Z');
  });

  it('reports a loss as minus one', () => {
    const view = toLatestPredictionView(
      prediction({ status: 'resolved', outcome: 'loss', settlementPrice: '79999', resolvedAt: CREATED_AT }),
    );
    expect(view.scoreDelta).toBe(-1);
  });

  it('claims no delta while a prediction is still pending', () => {
    const view = toLatestPredictionView(prediction());
    expect(view.scoreDelta).toBeNull();
    expect(view.outcome).toBeNull();
  });
});

describe('toMarketView', () => {
  it('formats the price and passes through the provider identity', () => {
    const view = toMarketView(
      { price: '82190.33000000', at: CREATED_AT, tradeId: 5, source: 'coinbase-exchange:BTC-USD' },
      false,
    );
    expect(view).toEqual({
      price: '82190.33',
      priceAt: '2026-10-15T12:00:00.000Z',
      source: 'coinbase-exchange:BTC-USD',
      simulated: false,
    });
  });
});
