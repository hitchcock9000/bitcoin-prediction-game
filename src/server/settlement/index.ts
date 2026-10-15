import { getConfig } from '../config';
import { getPool } from '../db/pool';
import { createGameStore, type GameStore } from '../game/store';
import { createPriceProvider } from '../prices';
import { startSettlementScheduler, type SettlementScheduler } from './scheduler';

/**
 * Process-wide singletons for the game's server-side dependencies.
 *
 * Cached on `globalThis` because Next.js re-evaluates modules on hot reload in
 * development; without this, every edit would start another scheduler.
 */
const globalForGame = globalThis as unknown as {
  __bpgGame?: { store: GameStore; scheduler: SettlementScheduler | null };
};

export function getGameStore(): GameStore {
  globalForGame.__bpgGame ??= { store: createGameStore(getPool()), scheduler: null };
  return globalForGame.__bpgGame.store;
}

export function getScheduler(): SettlementScheduler | null {
  return globalForGame.__bpgGame?.scheduler ?? null;
}

/**
 * Starts the in-process scheduler. Called once from instrumentation.ts when the
 * server process boots.
 *
 * @returns the scheduler, or null when it was deliberately not started.
 */
export function bootstrapSettlement(): SettlementScheduler | null {
  const config = getConfig();

  if (!config.settlementSchedulerEnabled) {
    console.log('[settlement] scheduler disabled via SETTLEMENT_SCHEDULER_ENABLED=false');
    return null;
  }

  const store = getGameStore();
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
    `[settlement] scheduler started — provider=${provider.name} interval=${config.settlementIntervalMs}ms`,
  );

  globalForGame.__bpgGame ??= { store, scheduler: null };
  globalForGame.__bpgGame.scheduler = scheduler;
  return scheduler;
}

/** Test/teardown helper. */
export function stopSettlement(): void {
  globalForGame.__bpgGame?.scheduler?.stop();
  if (globalForGame.__bpgGame) globalForGame.__bpgGame.scheduler = null;
}
