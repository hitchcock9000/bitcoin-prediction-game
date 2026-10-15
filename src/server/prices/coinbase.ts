import { isPositiveDecimal } from '@/domain/decimal';
import { PriceProviderError, type PriceProvider, type Quote } from '@/domain/types';

/**
 * Coinbase Exchange public market data.
 *
 * Chosen after checking the alternatives (see DECISIONS.md D2):
 *
 * - `GET /products/BTC-USD/ticker` returns a genuine BTC/**USD** pair. Binance
 *   only lists BTCUSDT, and it also refuses requests from some regions — a
 *   deployment-region-dependent outage we did not want to inherit.
 * - It includes a provider-reported `time` and a monotonic `trade_id`. The
 *   simpler Coinbase `/v2/prices/BTC-USD/spot` endpoint (and Kraken's ticker)
 *   return no timestamp at all, which would leave us measuring the 60-second
 *   rule with our own clock alone.
 * - No API key, generous rate limits, and a stable public endpoint.
 *
 * The response shape was verified against the live API rather than assumed:
 *   {"ask":"82189.17","bid":"82189.16","price":"82190.33",
 *    "trade_id":1106664073,"time":"2026-10-15T21:28:06.113600557Z"}
 *
 * The raw `price` string is passed through untouched — it is never parsed into
 * a float on the way in, so no precision is lost before it reaches
 * NUMERIC(18,8) in Postgres.
 */
export const COINBASE_SOURCE_NAME = 'coinbase-exchange:BTC-USD';

export interface CoinbaseProviderOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createCoinbaseProvider(options: CoinbaseProviderOptions = {}): PriceProvider {
  const baseUrl = (options.baseUrl ?? 'https://api.exchange.coinbase.com').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4000;

  return {
    name: COINBASE_SOURCE_NAME,
    simulated: false,

    async getQuote(signal?: AbortSignal): Promise<Quote> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const onExternalAbort = () => controller.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/products/BTC-USD/ticker`, {
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': 'bitcoin-prediction-game/1.0' },
          // Market data must never be served from a cache we do not control:
          // a cached body would carry an old provider timestamp and could look
          // like an unchanged price.
          cache: 'no-store',
        });
      } catch (error) {
        throw new PriceProviderError('Coinbase ticker request failed', error);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onExternalAbort);
      }

      if (!response.ok) {
        throw new PriceProviderError(`Coinbase ticker returned HTTP ${response.status}`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new PriceProviderError('Coinbase ticker returned a non-JSON body', error);
      }

      return parseCoinbaseTicker(payload);
    },
  };
}

/**
 * Exported so the parsing rules can be tested directly against a captured
 * response body.
 */
export function parseCoinbaseTicker(payload: unknown): Quote {
  if (typeof payload !== 'object' || payload === null) {
    throw new PriceProviderError('Coinbase ticker payload was not an object');
  }

  const body = payload as Record<string, unknown>;
  const price = body.price;

  // Keep the exact string the exchange sent. Anything malformed is rejected
  // rather than coerced: a price we cannot fully trust must not become an
  // entry price or a settlement price.
  if (typeof price !== 'string' || !isPositiveDecimal(price)) {
    throw new PriceProviderError(`Coinbase ticker returned an unusable price: ${JSON.stringify(price)}`);
  }

  const time = body.time;
  if (typeof time !== 'string') {
    throw new PriceProviderError('Coinbase ticker did not include a timestamp');
  }
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) {
    throw new PriceProviderError(`Coinbase ticker returned an unparseable timestamp: ${time}`);
  }

  const rawTradeId = body.trade_id;
  let tradeId: number | null = null;
  if (typeof rawTradeId === 'number' && Number.isSafeInteger(rawTradeId)) {
    tradeId = rawTradeId;
  } else if (typeof rawTradeId === 'string' && /^\d+$/.test(rawTradeId)) {
    const parsed = Number(rawTradeId);
    tradeId = Number.isSafeInteger(parsed) ? parsed : null;
  }

  return { price, at, tradeId, source: COINBASE_SOURCE_NAME };
}
