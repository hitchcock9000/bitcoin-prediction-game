import { evaluateEntryQuote } from '@/domain/rules';
import type { Direction, PriceProvider, Quote } from '@/domain/types';
import { PriceProviderError } from '@/domain/types';
import {
  ActivePredictionExistsError,
  type GameStore,
  type PlayerRecord,
  type PredictionRecord,
} from './store';

/**
 * The game service: the only place that combines player state, market data and
 * persistence. API route handlers are thin wrappers over this, which keeps the
 * HTTP layer free of rules and makes the same behaviour testable without
 * starting a server.
 */

export type EntryRefusalReason = 'provider_unavailable' | 'stale_quote' | 'quote_from_future';

/** The price could not be established, so no prediction can be created. */
export class PriceUnavailableError extends Error {
  constructor(
    readonly reason: EntryRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'PriceUnavailableError';
  }
}

export class PredictionAlreadyActiveError extends Error {
  constructor(readonly activePrediction: PredictionRecord) {
    super('You already have an open prediction');
    this.name = 'PredictionAlreadyActiveError';
  }
}

export interface PlayerState {
  player: PlayerRecord;
  activePrediction: PredictionRecord | null;
  /** Most recent prediction of any status — drives the win/loss banner. */
  latestPrediction: PredictionRecord | null;
}

export interface GameServiceDeps {
  store: GameStore;
  provider: PriceProvider;
  /** Injectable clock; defaults to the system clock. */
  now?: () => Date;
}

export function createGameService(deps: GameServiceDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    async getPlayerState(playerId: string): Promise<PlayerState> {
      const player = await deps.store.ensurePlayer(playerId);
      const [activePrediction, latestPrediction] = await Promise.all([
        deps.store.getActivePrediction(playerId),
        deps.store.getLatestPrediction(playerId),
      ]);
      return { player, activePrediction, latestPrediction };
    },

    /**
     * The price shown in the UI. Displayed only — never used to score
     * anything, so it carries no authority.
     */
    async getMarketQuote(): Promise<Quote> {
      try {
        return await deps.provider.getQuote();
      } catch (error) {
        throw new PriceUnavailableError(
          'provider_unavailable',
          error instanceof PriceProviderError ? error.message : 'Price feed unavailable',
        );
      }
    },

    async submitPrediction(input: {
      playerId: string;
      direction: Direction;
    }): Promise<{ state: PlayerState; prediction: PredictionRecord }> {
      // 1. The player exists (created with score 0 on first sight). The id comes
      //    from a verified server-signed cookie, never from the request body.
      await deps.store.ensurePlayer(input.playerId);

      // 2. Cheap pre-check so a player with an open prediction gets a clear
      //    answer without us calling the price API. This is a UX affordance,
      //    NOT the guarantee — the partial unique index is what actually makes
      //    a second pending prediction impossible under concurrency.
      const existing = await deps.store.getActivePrediction(input.playerId);
      if (existing) {
        throw new PredictionAlreadyActiveError(existing);
      }

      // 3. Entry price, always from the server's own provider call.
      const quote = await this.getMarketQuote();

      // 4. Refuse a quote we cannot place in time. No prediction is created:
      //    an unusable entry price would corrupt the whole round.
      const evaluation = evaluateEntryQuote(quote, now());
      if (!evaluation.ok) {
        throw new PriceUnavailableError(
          evaluation.reason,
          evaluation.reason === 'stale_quote'
            ? 'The latest price quote is too old to start from'
            : 'The latest price quote has an unreliable timestamp',
        );
      }

      // 5. Persist. `created_at` is the database's clock, and the entry quote's
      //    own timestamp is stored alongside the price so the 60-second window
      //    can be audited later.
      const prediction = await deps.store.createPrediction({
        playerId: input.playerId,
        direction: input.direction,
        entryPrice: quote.price,
        entryPriceAt: quote.at,
        entryTradeId: quote.tradeId,
        priceSource: quote.source,
      });

      return { state: await this.getPlayerState(input.playerId), prediction };
    },
  };
}

export type GameService = ReturnType<typeof createGameService>;

export { ActivePredictionExistsError };
