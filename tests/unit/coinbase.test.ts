import { describe, expect, it, vi } from 'vitest';
import { COINBASE_SOURCE_NAME, createCoinbaseProvider, parseCoinbaseTicker } from '@/server/prices/coinbase';
import { PriceProviderError } from '@/domain/types';

/**
 * The payloads below were captured from the live Coinbase Exchange public API
 * while designing this feature, so the parser is tested against real response
 * shapes rather than an invented schema.
 */
const LIVE_TICKER_RESPONSE = {
  ask: '82189.17',
  bid: '82189.16',
  volume: '7152.80223161',
  trade_id: 1106664073,
  price: '82190.33',
  size: '0.00006019',
  time: '2026-10-15T21:28:06.113600557Z',
  rfq_volume: '114.808932',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseCoinbaseTicker', () => {
  it('parses a real captured response', () => {
    const quote = parseCoinbaseTicker(LIVE_TICKER_RESPONSE);
    expect(quote.price).toBe('82190.33');
    expect(quote.at.toISOString()).toBe('2026-10-15T21:28:06.113Z');
    expect(quote.tradeId).toBe(1106664073);
    expect(quote.source).toBe(COINBASE_SOURCE_NAME);
  });

  it('passes the exchange price string through without float conversion', () => {
    // Round-tripping through Number() would lose the trailing digits; the
    // stored price must be exactly what the exchange reported.
    const quote = parseCoinbaseTicker({ ...LIVE_TICKER_RESPONSE, price: '82190.33000001' });
    expect(quote.price).toBe('82190.33000001');
  });

  it('accepts a string trade id', () => {
    expect(parseCoinbaseTicker({ ...LIVE_TICKER_RESPONSE, trade_id: '1106664073' }).tradeId).toBe(1106664073);
  });

  it('tolerates a missing trade id by falling back to timestamps', () => {
    const withoutTradeId = { ...LIVE_TICKER_RESPONSE } as Record<string, unknown>;
    delete withoutTradeId.trade_id;
    expect(parseCoinbaseTicker(withoutTradeId).tradeId).toBeNull();
  });

  it('ignores a nonsense trade id rather than coercing it', () => {
    expect(parseCoinbaseTicker({ ...LIVE_TICKER_RESPONSE, trade_id: 'abc' }).tradeId).toBeNull();
  });

  it.each([
    ['a non-object body', 42],
    ['a missing price', { ...LIVE_TICKER_RESPONSE, price: undefined }],
    ['a zero price', { ...LIVE_TICKER_RESPONSE, price: '0.00' }],
    ['a negative price', { ...LIVE_TICKER_RESPONSE, price: '-82190.33' }],
    ['a non-numeric price', { ...LIVE_TICKER_RESPONSE, price: 'eighty two thousand' }],
    ['a missing timestamp', { ...LIVE_TICKER_RESPONSE, time: undefined }],
    ['an unparseable timestamp', { ...LIVE_TICKER_RESPONSE, time: 'yesterday' }],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseCoinbaseTicker(payload)).toThrow(PriceProviderError);
  });
});

describe('createCoinbaseProvider', () => {
  it('requests the BTC-USD ticker with caching disabled', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(LIVE_TICKER_RESPONSE));
    const provider = createCoinbaseProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const quote = await provider.getQuote();

    expect(quote.price).toBe('82190.33');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.exchange.coinbase.com/products/BTC-USD/ticker');
    // A cached body would carry an old provider timestamp and could look like
    // an unchanged price — a direct threat to fair settlement.
    expect(init.cache).toBe('no-store');
    expect(provider.simulated).toBe(false);
  });

  it('respects a custom base url', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(LIVE_TICKER_RESPONSE));
    const provider = createCoinbaseProvider({
      baseUrl: 'https://example.test/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.getQuote();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.test/products/BTC-USD/ticker');
  });

  it('throws a PriceProviderError on an HTTP error', async () => {
    const provider = createCoinbaseProvider({
      fetchImpl: (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
    });
    await expect(provider.getQuote()).rejects.toBeInstanceOf(PriceProviderError);
  });

  it('throws a PriceProviderError when the body is not JSON', async () => {
    const provider = createCoinbaseProvider({
      fetchImpl: (async () => new Response('<html>maintenance</html>', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(provider.getQuote()).rejects.toBeInstanceOf(PriceProviderError);
  });

  it('throws a PriceProviderError when the network call fails', async () => {
    const provider = createCoinbaseProvider({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    await expect(provider.getQuote()).rejects.toBeInstanceOf(PriceProviderError);
  });

  it('aborts a request that exceeds the timeout', async () => {
    const provider = createCoinbaseProvider({
      timeoutMs: 10,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    await expect(provider.getQuote()).rejects.toBeInstanceOf(PriceProviderError);
  });
});
