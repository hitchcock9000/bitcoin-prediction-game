import { getPool } from '../db/pool';
import { createGameStore, type GameStore } from './store';

/**
 * Process-wide game store singleton.
 *
 * Cached on `globalThis` because Next.js re-evaluates modules on hot reload in
 * development, which would otherwise create a new pool on every edit.
 */
const globalForStore = globalThis as unknown as { __bpgStore?: GameStore };

export function getGameStore(): GameStore {
  globalForStore.__bpgStore ??= createGameStore(getPool());
  return globalForStore.__bpgStore;
}
