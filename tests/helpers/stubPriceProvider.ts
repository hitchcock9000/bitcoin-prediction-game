
import type { PriceProvider, Quote } from '@/domain/types';
import { PriceProviderError } from '@/domain/types';

/**
 * Test price providers.
 *
 * These live under tests/ on purpose: the simulated provider in src/ is for
 * running the app without market access, whereas these give exact control over
 * prices and timestamps for deterministic assertions.
 */

export class StubPriceProvider implements PriceProvider {
  readonly name = 'stub:BTC-USD';
  readonly simulated = true;
  calls = 0;

  constructor(private readonly behaviour: () => Quote | Promise<Quote>) {}

  async getQuote(): Promise<Quote> {
    this.calls += 1;
    return this.behaviour();
  }
}

export function quoteAt(price: string, at: Date, tradeId: number | null = 2_000_000): Quote {
  return { price, at, tradeId, source: 'stub:BTC-USD' };
}

/**
 * Always returns the given price, timestamped now.
 *
 * Trade ids default to the 2,000,000+ range on purpose: backdated predictions
 * in the fixtures use a lower entry trade id, so a stub quote is always a
 * genuinely later observation. (An earlier version of this helper shared the
 * same default trade id as the entry fixture, and the monotonic guard in
 * decideSettlement correctly refused to settle — a useful reminder that the
 * guard is not decorative.)
 */
export function fixedPrice(price: string, tradeId = 2_000_000): StubPriceProvider {
  return new StubPriceProvider(() => quoteAt(price, new Date(), tradeId));
}

/** Starting from `initial`, returns each subsequent price on each call. */
export function scriptedPrices(initial: string, ...rest: string[]): StubPriceProvider {
  const prices = [initial, ...rest];
  let index = 0;
  return new StubPriceProvider(() => {
    const price = prices[Math.min(index, prices.length - 1)] as string;
    index += 1;
    return quoteAt(price, new Date(), 2_000_000 + index);
  });
}

export function failingProvider(message = 'upstream unavailable'): StubPriceProvider {
  return new StubPriceProvider(() => {
    throw new PriceProviderError(message);
  });
}
