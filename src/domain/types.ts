/** Shared domain vocabulary. Deliberately free of any infrastructure import. */

export type Direction = 'up' | 'down';
export type Outcome = 'win' | 'loss';
export type PredictionStatus = 'pending' | 'resolved';

/**
 * A single BTC/USD observation from a price provider.
 *
 * `at` is the *provider's* timestamp for the quote, which is not the same as
 * the moment we received it. Settlement fairness depends on this distinction:
 * we must know when the market data was valid, not merely when we fetched it.
 */
export interface Quote {
  /** Exact decimal string, e.g. "82190.33". Never a float. */
  price: string;
  /** Provider-reported time for this quote. */
  at: Date;
  /**
   * Provider trade/sequence identifier, when available. Used as a monotonic
   * guard so a cached or replayed response can't be mistaken for a later quote.
   * Null when a provider does not expose one.
   */
  tradeId: number | null;
  /** Identifier of the provider that produced this quote. */
  source: string;
}

export interface PriceProvider {
  readonly name: string;
  /** True only for the test/dev simulated feed. Surfaced to the UI. */
  readonly simulated: boolean;
  /**
   * Fetches a single spot quote.
   * @throws {PriceProviderError} when no trustworthy quote can be obtained.
   *   Callers must treat a throw as "unknown price", never as "some price".
   */
  getQuote(signal?: AbortSignal): Promise<Quote>;
}

export class PriceProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PriceProviderError';
  }
}

/** Why a prediction is not yet settled. Shown verbatim in the UI. */
export type PendingReason =
  | 'too_early'
  | 'quote_not_after_entry'
  | 'price_unchanged'
  | 'stale_quote'
  | 'quote_from_future'
  | 'provider_unavailable';

export type SettlementDecision =
  | {
      kind: 'settle';
      outcome: Outcome;
      settlementPrice: string;
      settlementPriceAt: Date;
    }
  | { kind: 'pending'; reason: PendingReason };

export interface EntryQuoteRejection {
  ok: false;
  reason: 'quote_from_future' | 'stale_quote';
}

export type EntryQuoteEvaluation = { ok: true } | EntryQuoteRejection;
