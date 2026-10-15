import { RULES, decideSettlement } from '@/domain/rules';
import { PriceProviderError, type PendingReason, type PriceProvider, type Quote } from '@/domain/types';
import type { GameStore } from '../game/store';

/**
 * One settlement sweep.
 *
 * This function is the single place where predictions are resolved. The
 * scheduler calls it on a timer, an API route calls it opportunistically, and
 * an external cron can call it over HTTP — all three invoke *this* code, so the
 * policy cannot drift between execution paths.
 *
 * Why a sweep rather than a timer per prediction: a per-prediction timer lives
 * in process memory and dies on restart or redeploy, silently stranding the
 * prediction. A sweep is stateless — it discovers work from the database — so
 * anything interrupted is picked up on the next tick or after a restart.
 */

export interface SweepDecisionLog {
  predictionId: string;
  playerId: string;
  outcome: 'settled' | 'pending' | 'race_lost';
  reason?: PendingReason;
}

export interface SweepResult {
  /** Pending predictions whose 60 seconds had elapsed at selection time. */
  examined: number;
  settled: number;
  stillPending: number;
  /** False when the provider could not be reached this sweep. */
  providerAvailable: boolean;
  decisions: SweepDecisionLog[];
}

export interface SweepDeps {
  store: GameStore;
  provider: PriceProvider;
  batchSize?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export async function runSettlementSweep(deps: SweepDeps): Promise<SweepResult> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const batchSize = deps.batchSize ?? RULES.settlementBatchSize;

  const { candidates, dbNow } = await store.listSweepable({
    waitSeconds: RULES.minWaitMs / 1000,
    limit: batchSize,
  });

  if (candidates.length === 0 || dbNow === null) {
    // No provider call at all when there is nothing to settle. An idle server
    // should not be hammering the exchange, and it should not be able to fail
    // a sweep it did not need.
    return { examined: 0, settled: 0, stillPending: 0, providerAvailable: true, decisions: [] };
  }

  // One quote per sweep, shared by every prediction in the batch.
  //
  // This is a policy choice, not an optimisation detail. Taking a fresh quote
  // per prediction would mean two players who reached their deadline in the
  // same tick could be scored against different prices. Sharing the quote makes
  // a sweep a single, consistent observation of the market, and the provider
  // timestamp recorded on each row keeps it auditable.
  let quote: Quote | null = null;
  let providerAvailable = true;
  try {
    quote = await provider.getQuote();
  } catch (error) {
    providerAvailable = false;
    log('provider_unavailable', {
      provider: provider.name,
      message: error instanceof PriceProviderError ? error.message : String(error),
    });
  }

  const decisions: SweepDecisionLog[] = [];
  let settled = 0;

  for (const candidate of candidates) {
    if (candidate.priceSource !== provider.name) {
      // Only reachable if PRICE_PROVIDER was changed while predictions were
      // open. We still settle (the player should not be stranded), but it is
      // worth a warning: entry and settlement price then come from different
      // venues.
      log('price_source_changed', {
        predictionId: candidate.id,
        entrySource: candidate.priceSource,
        settlementSource: provider.name,
      });
    }

    const decision = decideSettlement({
      direction: candidate.direction,
      entryPrice: candidate.entryPrice,
      entryPriceAt: candidate.entryPriceAt,
      entryTradeId: candidate.entryTradeId,
      createdAt: candidate.createdAt,
      quote,
      // The database's clock, not this process's. Same clock that stamped
      // created_at and that the CHECK constraint will validate resolved_at
      // against.
      now: dbNow,
    });

    if (decision.kind === 'pending') {
      decisions.push({
        predictionId: candidate.id,
        playerId: candidate.playerId,
        outcome: 'pending',
        reason: decision.reason,
      });
      continue;
    }

    const result = await store.settlePrediction({
      predictionId: candidate.id,
      outcome: decision.outcome,
      settlementPrice: decision.settlementPrice,
      settlementPriceAt: decision.settlementPriceAt,
    });

    if (result.settled) {
      settled += 1;
      decisions.push({ predictionId: candidate.id, playerId: candidate.playerId, outcome: 'settled' });
      log('prediction_settled', {
        predictionId: candidate.id,
        outcome: decision.outcome,
        entryPrice: candidate.entryPrice,
        settlementPrice: decision.settlementPrice,
      });
    } else {
      // Another worker got there first. Expected and harmless: the conditional
      // UPDATE made this a no-op instead of a second score change.
      decisions.push({ predictionId: candidate.id, playerId: candidate.playerId, outcome: 'race_lost' });
      log('settlement_race_lost', { predictionId: candidate.id });
    }
  }

  return {
    examined: candidates.length,
    settled,
    stillPending: candidates.length - settled,
    providerAvailable,
    decisions,
  };
}
