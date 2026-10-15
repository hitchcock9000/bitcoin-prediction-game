import { trimDecimal } from '@/domain/decimal';
import { RULES, deadlineFor } from '@/domain/rules';
import type { Quote } from '@/domain/types';
import type {
  ActivePredictionView,
  GameStateView,
  LatestPredictionView,
  MarketView,
} from '@/shared/api';
import type { PredictionRecord } from '../game/store';

// The DTO shapes live in src/shared/api.ts so the browser can import the
// contract as types without importing any server code.
export type { ActivePredictionView, GameStateView, LatestPredictionView, MarketView };

/**
 * Mapping from database records to the JSON the browser sees.
 *
 * This is a deliberate boundary rather than `return row`:
 *
 * - Internal columns (entry trade id, price source, the exact stored scale) are
 *   not part of the client contract and do not leak.
 * - Prices are normalised for display with `trimDecimal`, so `80000.00000000`
 *   from a NUMERIC(18,8) column does not reach the UI as noise.
 * - Everything the browser needs in order to be *rendered* is present, and
 *   nothing that would let it decide anything is.
 */

export function toMarketView(quote: Quote, simulated: boolean): MarketView {
  return {
    price: trimDecimal(quote.price, 2),
    priceAt: quote.at.toISOString(),
    source: quote.source,
    simulated,
  };
}

export function toActivePredictionView(
  prediction: PredictionRecord,
  now: Date,
  explanation: string,
): ActivePredictionView {
  const deadline = deadlineFor(prediction.createdAt);

  // The deadline is anchored to the database clock (createdAt), while `now` is
  // the application clock read before the row was written. The two differ by at
  // least the insert latency, so a naive ceil() reports 61 seconds remaining
  // immediately after creation — which the smoke test caught. Clamping to the
  // configured wait is correct rather than merely cosmetic: the remaining time
  // cannot exceed the rule's own window, because createdAt is necessarily at or
  // after the moment the prediction was requested.
  const secondsRemaining = Math.min(
    RULES.minWaitMs / 1000,
    Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 1000)),
  );

  return {
    id: prediction.id,
    direction: prediction.direction,
    entryPrice: trimDecimal(prediction.entryPrice, 2),
    entryPriceAt: prediction.entryPriceAt.toISOString(),
    createdAt: prediction.createdAt.toISOString(),
    deadlineAt: deadline.toISOString(),
    secondsRemaining,
    explanation,
  };
}

export function toLatestPredictionView(prediction: PredictionRecord): LatestPredictionView {
  return {
    id: prediction.id,
    direction: prediction.direction,
    entryPrice: trimDecimal(prediction.entryPrice, 2),
    createdAt: prediction.createdAt.toISOString(),
    status: prediction.status,
    outcome: prediction.outcome,
    settlementPrice:
      prediction.settlementPrice === null ? null : trimDecimal(prediction.settlementPrice, 2),
    resolvedAt: prediction.resolvedAt?.toISOString() ?? null,
    scoreDelta: prediction.outcome === null ? null : prediction.outcome === 'win' ? 1 : -1,
  };
}

