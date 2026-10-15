import type { PriceProvider } from '@/domain/types';
import type { AppConfig } from '../config';
import { createCoinbaseProvider } from './coinbase';
import { createSimulatedProvider } from './simulated';

/**
 * The one place that decides which market data source the server uses.
 *
 * Every caller (settlement sweep, API routes) goes through here, so the entry
 * price and the settlement price can only ever come from the same provider.
 * The config layer has already rejected `simulated` in production unless it was
 * explicitly allowed.
 */
export function createPriceProvider(config: AppConfig): PriceProvider {
  if (config.priceProvider === 'simulated') {
    return createSimulatedProvider({ seed: Number(process.env.SIMULATED_PRICE_SEED ?? 7) });
  }
  return createCoinbaseProvider({
    baseUrl: config.coinbaseApiBase,
    timeoutMs: config.priceFetchTimeoutMs,
  });
}
