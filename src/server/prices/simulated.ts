import { PriceProviderError, type PriceProvider, type Quote } from '@/domain/types';

/**
 * Development/demo price feed.
 *
 * Scope limit (deliberate): this exists so the app can be run and demonstrated
 * in an environment with no outbound access to market data APIs, and so the
 * UI states can be exercised on demand. It is NOT part of the game's
 * correctness story — every rule is tested against a stub provider and the
 * real adapter.
 *
 * Guard rails:
 * - `loadConfig` refuses `PRICE_PROVIDER=simulated` in production unless
 *   `ALLOW_SIMULATED_PRICES=true` is set deliberately.
 * - The provider reports `simulated: true`, which the API surfaces to the UI as
 *   a visible "simulated prices" marker, so a viewer can never mistake it for
 *   live market data.
 */
export const SIMULATED_SOURCE_NAME = 'simulated:dev-only';

export interface SimulatedProviderOptions {
  /** Starting price. */
  startPrice?: number;
  /** Deterministic seed so runs are reproducible. */
  seed?: number;
  /** Fixed number of basis points to move on each tick (disables randomness). */
  stepBps?: number;
  /** Minimum interval between price changes, in ms. */
  tickMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/** Small deterministic PRNG (mulberry32) — no dependency needed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSimulatedProvider(options: SimulatedProviderOptions = {}): PriceProvider {
  const tickMs = options.tickMs ?? 1000;
  const now = options.now ?? (() => new Date());
  const random = mulberry32(options.seed ?? 1);

  let price = options.startPrice ?? 82_000;
  let lastChangeAt = 0;

  return {
    name: SIMULATED_SOURCE_NAME,
    simulated: true,

    async getQuote(): Promise<Quote> {
      const at = now();
      const elapsed = at.getTime() - lastChangeAt;

      if (lastChangeAt === 0 || elapsed >= tickMs) {
        // Move by a small, realistic-looking amount each tick. Without this the
        // price would be frozen and every prediction would stay pending
        // forever on "price unchanged" — which is correct behaviour but a
        // useless demo.
        const bps =
          options.stepBps ??
          (random() < 0.5 ? -1 : 1) * (1 + random() * 6); // ±0.01%..0.07%
        price = price * (1 + bps / 10_000);
        lastChangeAt = at.getTime();
      }

      const formatted = price.toFixed(2);
      if (!/^\d+(\.\d+)?$/.test(formatted) || Number(formatted) <= 0) {
        throw new PriceProviderError(`Simulated provider produced an invalid price: ${formatted}`);
      }

      return {
        price: formatted,
        at,
        // Monotonic by construction, so the settlement ordering guard behaves
        // the same way it would with a real sequence number.
        tradeId: at.getTime(),
        source: SIMULATED_SOURCE_NAME,
      };
    },
  };
}
