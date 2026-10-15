/**
 * The HTTP contract, shared by the server (which produces it) and the browser
 * (which renders it).
 *
 * Types only — no imports, no runtime code — so the client bundle can depend on
 * the contract without pulling in a single line of server implementation.
 */

export interface MarketView {
  /** Exact decimal string, normalised for display. */
  price: string;
  /** Provider timestamp for this quote. */
  priceAt: string;
  source: string;
  /** True when this deployment serves simulated prices rather than live data. */
  simulated: boolean;
}

export interface ActivePredictionView {
  id: string;
  direction: 'up' | 'down';
  entryPrice: string;
  entryPriceAt: string;
  createdAt: string;
  /** createdAt + 60s, computed server-side. */
  deadlineAt: string;
  /** Seconds left on the minimum wait, as of this response. Informational. */
  secondsRemaining: number;
  /** Short, user-facing explanation of what is still being waited for. */
  explanation: string;
}

export interface LatestPredictionView {
  id: string;
  direction: 'up' | 'down';
  entryPrice: string;
  createdAt: string;
  status: 'pending' | 'resolved';
  outcome: 'win' | 'loss' | null;
  settlementPrice: string | null;
  resolvedAt: string | null;
  scoreDelta: 1 | -1 | null;
}

export interface GameStateView {
  player: { score: number };
  market: MarketView | null;
  marketUnavailable: boolean;
  activePrediction: ActivePredictionView | null;
  latestPrediction: LatestPredictionView | null;
  serverTime: string;
  priceSource: { name: string; simulated: boolean };
}

export interface ApiErrorBody {
  error: { code: string; message: string; reason?: string };
}

/** A `409` carries the current state so the UI can recover immediately. */
export interface ConflictBody extends ApiErrorBody {
  state: GameStateView;
}
