import { compareDecimal } from './decimal';
import type {
  Direction,
  EntryQuoteEvaluation,
  Outcome,
  PendingReason,
  Quote,
  SettlementDecision,
} from './types';

/**
 * The game's tuning constants, in one place so they can be reasoned about and
 * tested directly. Every value here is a deliberate policy choice; see README
 * ("Settlement policy") and DECISIONS.md.
 */
export const RULES = {
  /** Business rule 6: at least 60s between prediction creation and resolution. */
  minWaitMs: 60_000,

  /**
   * How old a quote may be and still be used as an *entry* price.
   *
   * This is defence against a provider serving a cached or hung response: we
   * would otherwise record a price that was already stale as the player's
   * starting point, and the 60s window would be measured from the wrong market
   * moment. Rejecting is the safe failure: no prediction is created.
   */
  entryQuoteMaxAgeMs: 15_000,

  /**
   * How far ahead of our own clock a provider timestamp may be.
   *
   * Small tolerances are normal (clock drift, rounding). Anything larger means
   * we cannot reason about ordering, so we refuse rather than guess.
   */
  quoteMaxFutureSkewMs: 5_000,

  /**
   * How old the newest quote may be before we refuse to settle on it.
   *
   * Deliberately generous: a few seconds of provider cache is harmless. This
   * only trips when the feed is genuinely not delivering, in which case
   * settling would mean inventing an outcome.
   */
  settlementQuoteMaxAgeMs: 30_000,

  /** How many pending predictions one sweep will process. */
  settlementBatchSize: 25,

  /** Scheduler tick interval. See src/server/settlement/scheduler.ts. */
  settlementTickMs: 5_000,
} as const;

/**
 * Validates a quote for use as an entry price.
 *
 * Note this only checks *timing*; the provider adapter is responsible for
 * rejecting malformed or non-positive payloads.
 */
export function evaluateEntryQuote(quote: Quote, now: Date): EntryQuoteEvaluation {
  const ageMs = now.getTime() - quote.at.getTime();

  if (ageMs < -RULES.quoteMaxFutureSkewMs) {
    return { ok: false, reason: 'quote_from_future' };
  }
  if (ageMs > RULES.entryQuoteMaxAgeMs) {
    return { ok: false, reason: 'stale_quote' };
  }
  return { ok: true };
}

export function deadlineFor(createdAt: Date): Date {
  return new Date(createdAt.getTime() + RULES.minWaitMs);
}

export interface SettlementInput {
  direction: Direction;
  entryPrice: string;
  entryPriceAt: Date;
  entryTradeId: number | null;
  createdAt: Date;
  /**
   * Newest quote available right now, or `null` if the provider could not be
   * reached. `null` is a first-class case: it means "we do not know the price",
   * which must never be converted into an outcome.
   */
  quote: Quote | null;
  /** Server clock. Never a client-supplied time. */
  now: Date;
}

/**
 * The whole settlement rule, as a pure function.
 *
 * Deterministic and side-effect free so it can be tested exhaustively with a
 * controllable clock and without a database. Checks are ordered from "we are
 * not ready to decide" to "we can decide", and the first failing check returns
 * a named reason the UI can show the player.
 *
 * Deliberately returns `kind: 'pending'` in every ambiguous case. A prediction
 * that stays pending is a visible wait; a wrong score is an invisible bug.
 */
export function decideSettlement(input: SettlementInput): SettlementDecision {
  const { quote, now } = input;
  const deadline = deadlineFor(input.createdAt);

  // 1. The wait is a hard floor. Checked before anything else so that a slow
  //    provider during the countdown cannot influence the outcome.
  if (now.getTime() < deadline.getTime()) {
    return { kind: 'pending', reason: 'too_early' };
  }

  // 2. No quote means no known price. Never fabricate one.
  if (quote === null) {
    return { kind: 'pending', reason: 'provider_unavailable' };
  }

  // 3. Reject timestamps we cannot order confidently.
  const ageMs = now.getTime() - quote.at.getTime();
  if (ageMs < -RULES.quoteMaxFutureSkewMs) {
    return { kind: 'pending', reason: 'quote_from_future' };
  }
  if (ageMs > RULES.settlementQuoteMaxAgeMs) {
    return { kind: 'pending', reason: 'stale_quote' };
  }

  // 4. The settlement quote must be genuinely later than the entry quote.
  //    Comparing trade ids catches the case where a provider (or an
  //    intermediary cache) replays an older payload with a rounded timestamp.
  if (quote.at.getTime() <= input.entryPriceAt.getTime()) {
    return { kind: 'pending', reason: 'quote_not_after_entry' };
  }
  if (
    quote.tradeId !== null &&
    input.entryTradeId !== null &&
    quote.tradeId <= input.entryTradeId
  ) {
    return { kind: 'pending', reason: 'quote_not_after_entry' };
  }

  // 5. Business rule: "the BTC price has changed relative to the recorded
  //    entry price". Unchanged is not a win and not a loss, so we keep waiting
  //    for a later quote that has actually moved.
  const movement = compareDecimal(quote.price, input.entryPrice);
  if (movement === 0) {
    return { kind: 'pending', reason: 'price_unchanged' };
  }

  // 6. Score it.
  return {
    kind: 'settle',
    outcome: outcomeFor(input.direction, movement),
    settlementPrice: quote.price,
    settlementPriceAt: quote.at,
  };
}

/**
 * `movement` is the result of comparing settlement price against entry price.
 * UP wins on a strictly higher price, DOWN on a strictly lower price.
 */
export function outcomeFor(direction: Direction, movement: -1 | 0 | 1): Outcome {
  if (movement === 0) {
    throw new Error('Unchanged prices have no outcome and must not be scored');
  }
  const won = direction === 'up' ? movement > 0 : movement < 0;
  return won ? 'win' : 'loss';
}

export function scoreDeltaFor(outcome: Outcome): 1 | -1 {
  return outcome === 'win' ? 1 : -1;
}

/** Human-readable explanation for a pending state, shown to the player. */
export function describePendingReason(reason: PendingReason): string {
  switch (reason) {
    case 'too_early':
      return 'Waiting for the 60 second window to pass.';
    case 'quote_not_after_entry':
      return 'Waiting for a quote that is newer than your entry price.';
    case 'price_unchanged':
      return 'The price has not moved yet — the prediction stays open until it does.';
    case 'stale_quote':
      return 'The latest market quote is out of date, so the result is on hold.';
    case 'quote_from_future':
      return 'The market quote timestamp looks unreliable, so the result is on hold.';
    case 'provider_unavailable':
      return 'The price feed is unavailable right now. Your prediction is still open.';
  }
}
