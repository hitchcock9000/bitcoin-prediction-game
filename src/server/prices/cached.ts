import type { PriceProvider, Quote } from '@/domain/types';

/**
 * A short-TTL cache in front of a price provider, used **only for the price
 * displayed in the UI**.
 *
 * Why it exists: the browser polls the game state every few seconds, and every
 * poll needs a price. Without a cache, N players polling every 3 seconds means
 * N/3 upstream requests per second, which would hit exchange rate limits long
 * before the game hits any other limit. This is the answer to "how would you
 * handle 10,000 players" for the market-data side of the system.
 *
 * Why it is scoped to display: entry and settlement prices must never come from
 * a cache, because they decide points. The promotion/relegation of authority is
 * explicit here rather than implicit in a config flag.
 *
 * Behaviour on provider failure: a recently cached quote (within
 * `maxStaleOnErrorMs`) is served so a momentary wobble does not blank the UI.
 * Beyond that the error propagates, because showing a price that is minutes old
 * as "the latest price" would be misleading.
 */
export interface CachedPriceProviderOptions {
  ttlMs?: number;
  maxStaleOnErrorMs?: number;
  now?: () => Date;
}

export interface CachedPriceProvider extends PriceProvider {
  /** For tests and diagnostics. */
  readonly stats: { hits: number; misses: number; staleServed: number; errors: number };
}

export function createCachedPriceProvider(
  provider: PriceProvider,
  options: CachedPriceProviderOptions = {},
): CachedPriceProvider {
  const ttlMs = options.ttlMs ?? 2_000;
  const maxStaleOnErrorMs = options.maxStaleOnErrorMs ?? 30_000;
  const now = options.now ?? (() => new Date());

  let cached: Quote | null = null;
  let cachedAtMs = 0;
  const stats = { hits: 0, misses: 0, staleServed: 0, errors: 0 };

  return {
    name: provider.name,
    simulated: provider.simulated,
    stats,

    async getQuote(signal?: AbortSignal): Promise<Quote> {
      const currentMs = now().getTime();
      if (cached && currentMs - cachedAtMs < ttlMs) {
        stats.hits += 1;
        return cached;
      }

      try {
        const quote = await provider.getQuote(signal);
        cached = quote;
        cachedAtMs = currentMs;
        stats.misses += 1;
        return quote;
      } catch (error) {
        stats.errors += 1;
        if (cached && currentMs - cachedAtMs <= maxStaleOnErrorMs) {
          stats.staleServed += 1;
          return cached;
        }
        throw error;
      }
    },
  };
}
