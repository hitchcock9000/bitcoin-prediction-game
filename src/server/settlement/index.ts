import { getConfig } from '../config';
import { getGameStore } from '../game/runtime';
import { createPriceProvider } from '../prices';
import { startSettlementScheduler, type SettlementScheduler } from './scheduler';

/**
 * Process-wide settlement scheduler handle.
 *
 * Cached on `globalThis` because Next.js re-evaluates modules on hot reload in
 * development; without this, every edit would start another scheduler.
 */
const globalForSettlement = globalThis as unknown as { __bpgScheduler?: SettlementScheduler | null };

export function getScheduler(): SettlementScheduler | null {
  return globalForSettlement.__bpgScheduler ?? null;
}

export function isSchedulerEnabled(): boolean {
  try {
    return getConfig().settlementSchedulerEnabled;
  } catch {
    // Config missing (no DATABASE_URL): report disabled rather than throwing
    // from a health check.
    return false;
  }
}

/**
 * Starts the in-process scheduler. Called once from instrumentation.ts when the
 * server process boots — in development and in production alike.
 *
 * @returns the scheduler, or null when it was deliberately not started.
 */
export function bootstrapSettlement(): SettlementScheduler | null {
  if (globalForSettlement.__bpgScheduler) {
    console.log('[settlement] scheduler already running in this process');
    return globalForSettlement.__bpgScheduler;
  }

  const config = getConfig();

  if (!config.settlementSchedulerEnabled) {
    console.log('[settlement] scheduler disabled via SETTLEMENT_SCHEDULER_ENABLED=false');
    return null;
  }

  const store = getGameStore();
  // Settlement always uses the live provider, never a cache.
  const provider = createPriceProvider(config);

  const scheduler = startSettlementScheduler({
    store,
    provider,
    intervalMs: config.settlementIntervalMs,
    log: (event, data) => {
      // Plain structured logs. Deliberately boring: on a small deployment these
      // go to the host's log viewer, which is enough to answer "did it settle,
      // and did the provider answer?" without any extra infrastructure.
      console.log(`[settlement] ${event} ${JSON.stringify(data)}`);
    },
  });

  console.log(
    `[settlement] scheduler started — provider=${provider.name} simulated=${provider.simulated} interval=${config.settlementIntervalMs}ms`,
  );

  globalForSettlement.__bpgScheduler = scheduler;
  return scheduler;
}

/** Health-check helper. */
export function isSchedulerRunning(): boolean {
  return getScheduler()?.isRunning() ?? false;
}

