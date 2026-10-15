import { getConfig } from '../config';
import { getGameStore } from '../game/runtime';
import { createGameService } from '../game/service';
import { createPriceProvider } from '../prices';
import { createCachedPriceProvider } from '../prices/cached';
import { getScheduler, isSchedulerEnabled, isSchedulerRunning } from '../settlement';
import { createHandlers, type Handlers } from './handlers';

/**
 * Wires the real dependencies for the route handlers.
 *
 * The route files under `src/app/api/**` are two-line wrappers around this, so
 * there is exactly one place where the application's collaborators are chosen
 * and exactly one place where the tests substitute them (by calling
 * `createHandlers` directly with stubs).
 */
const globalForHandlers = globalThis as unknown as { __bpgHandlers?: Handlers };

export function getHandlers(): Handlers {
  if (!globalForHandlers.__bpgHandlers) {
    const config = getConfig();
    const store = getGameStore();
    const liveProvider = createPriceProvider(config);

    globalForHandlers.__bpgHandlers = createHandlers({
      store,
      service: createGameService({ store, provider: liveProvider }),
      // Display prices may be a couple of seconds old, which bounds upstream
      // request volume. Entry and settlement prices never come from here.
      displayProvider: createCachedPriceProvider(liveProvider, { ttlMs: 2_000 }),
      settlementProvider: liveProvider,
      scheduler: {
        enabled: isSchedulerEnabled(),
        running: () => isSchedulerRunning() || getScheduler() !== null,
      },
      settlementSecret: config.settlementSecret,
      cookieSecret: config.playerCookieSecret,
      cookieSecure: config.cookieSecure,
      cookieSameSite: config.cookieSameSite,
      log: (event, data) => console.log(`[api] ${event} ${JSON.stringify(data)}`),
    });
  }
  return globalForHandlers.__bpgHandlers;
}

/** Test helper. */
export function resetHandlersForTests(): void {
  globalForHandlers.__bpgHandlers = undefined;
}
