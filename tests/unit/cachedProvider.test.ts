import { describe, expect, it } from 'vitest';
import { createCachedPriceProvider } from '@/server/prices/cached';
import { PriceProviderError } from '@/domain/types';
import { failingProvider, quoteAt, StubPriceProvider } from '../helpers/stubPriceProvider';

/**
 * The display-price cache. It exists to bound upstream request volume when many
 * browsers poll the game state, and it is deliberately used *only* for the
 * price shown in the UI — never for an entry or settlement price.
 */
const T0 = new Date('2026-10-15T12:00:00.000Z');

function clock(start: Date) {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current = new Date(current.getTime() + ms)) };
}

describe('createCachedPriceProvider', () => {
  it('serves a repeat request from cache inside the TTL', async () => {
    const time = clock(T0);
    const upstream = new StubPriceProvider(() => quoteAt('80000.00', time.now()));
    const provider = createCachedPriceProvider(upstream, { ttlMs: 2_000, now: time.now });

    await provider.getQuote();
    time.advance(1_500);
    const second = await provider.getQuote();

    expect(upstream.calls).toBe(1);
    expect(second.price).toBe('80000.00');
    expect(provider.stats.hits).toBe(1);
  });

  it('refetches once the TTL has passed', async () => {
    const time = clock(T0);
    let price = '80000.00';
    const upstream = new StubPriceProvider(() => quoteAt(price, time.now()));
    const provider = createCachedPriceProvider(upstream, { ttlMs: 2_000, now: time.now });

    await provider.getQuote();
    time.advance(2_001);
    price = '80100.00';
    const second = await provider.getQuote();

    expect(upstream.calls).toBe(2);
    expect(second.price).toBe('80100.00');
  });

  it('serves the last known quote through a brief provider outage', async () => {
    const time = clock(T0);
    let failing = false;
    const upstream = new StubPriceProvider(() => {
      if (failing) throw new PriceProviderError('upstream down');
      return quoteAt('80000.00', time.now());
    });
    const provider = createCachedPriceProvider(upstream, { ttlMs: 2_000, maxStaleOnErrorMs: 30_000, now: time.now });

    await provider.getQuote();
    failing = true;
    time.advance(10_000);

    const quote = await provider.getQuote();
    expect(quote.price).toBe('80000.00');
    expect(provider.stats.staleServed).toBe(1);
  });

  it('propagates the error once the cached quote is too old to show', async () => {
    const time = clock(T0);
    let failing = false;
    const upstream = new StubPriceProvider(() => {
      if (failing) throw new PriceProviderError('upstream down');
      return quoteAt('80000.00', time.now());
    });
    const provider = createCachedPriceProvider(upstream, { ttlMs: 2_000, maxStaleOnErrorMs: 30_000, now: time.now });

    await provider.getQuote();
    failing = true;
    time.advance(31_000);

    // Showing a price that is minutes old as "the latest price" would mislead.
    await expect(provider.getQuote()).rejects.toBeInstanceOf(PriceProviderError);
  });

  it('propagates the error when nothing has ever been cached', async () => {
    const time = clock(T0);
    const provider = createCachedPriceProvider(failingProvider(), { now: time.now });
    await expect(provider.getQuote()).rejects.toBeInstanceOf(PriceProviderError);
  });

  it('reports the underlying provider identity so the UI can label simulated data', () => {
    const upstream = new StubPriceProvider(() => quoteAt('1.00', T0));
    const provider = createCachedPriceProvider(upstream);
    expect(provider.name).toBe(upstream.name);
    expect(provider.simulated).toBe(upstream.simulated);
  });
});
