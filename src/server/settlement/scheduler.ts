import { RULES } from '@/domain/rules';
import type { PriceProvider } from '@/domain/types';
import type { GameStore } from '../game/store';
import { runSettlementSweep, type SweepResult } from './runner';

/**
 * In-process settlement scheduler.
 *
 * Why this shape: the assignment requires that a prediction resolves whether or
 * not the player keeps the page open. A per-request check cannot do that (the
 * player may simply close the tab, or never return), so resolution has to be
 * driven by the server on a timer.
 *
 * A `setInterval` in the web process is the smallest thing that satisfies
 * that — no queue, no worker dyno, no extra service to pay for and monitor. The
 * prerequisite is a long-running process, which is why the deployment target is
 * a container host rather than a serverless platform.
 *
 * Honest limitations (these are real; see README "Known limitations"):
 *
 * 1. Suspension — on a host that suspends or scales-to-zero idle containers
 *    (free tiers, for example), ticks do not fire while suspended. Predictions
 *    settle late, but never incorrectly: settlement is driven by the recorded
 *    `created_at`, so the first tick after waking resolves everything that was
 *    due. The result is a delay, not a wrong outcome.
 * 2. Restarts — nothing is held in memory. Pending predictions are rows in
 *    Postgres, so a deploy, crash or restart loses no work; the first sweep
 *    after boot picks up every prediction whose window has elapsed.
 * 3. Multiple instances — safe but redundant. Two schedulers racing is
 *    handled by the conditional settlement UPDATE: one wins, the other sees
 *    `settled: false` and changes no score. The cost of N instances is N
 *    provider polls per tick, which is why `SETTLEMENT_SCHEDULER_ENABLED=false`
 *    exists for all but one instance (or simply run one instance).
 * 4. Single point of failure — if the process is down, nothing settles until
 *    it is back. The `POST /api/settle` endpoint exists so an external cron can
 *    drive the same sweep, and so the mechanism stays verifiable by hand.
 */

export interface SchedulerDeps {
  store: GameStore;
  provider: PriceProvider;
  intervalMs?: number;
  batchSize?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface SettlementScheduler {
  runOnce: () => Promise<SweepResult>;
  stop: () => void;
  isRunning: () => boolean;
}

export function startSettlementScheduler(deps: SchedulerDeps): SettlementScheduler {
  const intervalMs = deps.intervalMs ?? RULES.settlementTickMs;
  const log = deps.log ?? (() => {});

  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<SweepResult> | null = null;
  let stopped = false;

  async function runOnce(): Promise<SweepResult> {
    // Overlap guard: a slow sweep (e.g. a hung provider request) must not let
    // the next tick start a second concurrent sweep in the same process.
    if (inFlight) {
      log('sweep_skipped_overlap', {});
      return inFlight;
    }

    inFlight = runSettlementSweep({
      store: deps.store,
      provider: deps.provider,
      batchSize: deps.batchSize,
      log,
    })
      .then((result) => {
        if (result.examined > 0) {
          log('sweep_complete', {
            examined: result.examined,
            settled: result.settled,
            stillPending: result.stillPending,
            providerAvailable: result.providerAvailable,
          });
        }
        return result;
      })
      .catch((error) => {
        // A failed sweep must never kill the scheduler; the next tick retries.
        log('sweep_failed', { message: error instanceof Error ? error.message : String(error) });
        return {
          examined: 0,
          settled: 0,
          stillPending: 0,
          providerAvailable: false,
          decisions: [],
        } satisfies SweepResult;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  // Sweep immediately on start so a restart resolves anything that came due
  // while the process was down, instead of waiting a full interval.
  void runOnce();

  timer = setInterval(() => {
    if (stopped) return;
    void runOnce();
  }, intervalMs);
  // Do not keep the process alive purely for settlement ticks.
  timer.unref?.();

  return {
    runOnce,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    isRunning: () => !stopped,
  };
}
