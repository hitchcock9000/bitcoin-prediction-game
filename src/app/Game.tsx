'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd } from '@/domain/decimal';
import type { ActivePredictionView, ApiErrorBody, ConflictBody, GameStateView } from '@/shared/api';

/**
 * The whole game UI.
 *
 * Design rules this file follows:
 *
 * 1. **It decides nothing.** Every piece of game state — score, price, whether a
 *    prediction may be placed, what the result was — comes from the server.
 *    There is no scoring logic and no outcome logic here.
 * 2. **The countdown is decoration.** It is seeded from `secondsRemaining` in
 *    each poll response and ticked locally between polls so it feels alive. It
 *    never triggers anything; when it hits zero the UI simply waits for the
 *    server to report the resolved prediction. A wrong client clock cannot
 *    change a result.
 * 3. **Every state is explicit.** Loading, ready, submitting, pending, won,
 *    lost, price unavailable and recoverable error each get their own visible
 *    treatment, so a player is never left wondering whether a tap registered.
 */

const ACTIVE_POLL_INTERVAL_MS = 3_000;
const IDLE_POLL_INTERVAL_MS = 10_000;
const MIN_WAIT_SECONDS = 60;

type Submitting = 'up' | 'down' | null;

export default function Game() {
  const [state, setState] = useState<GameStateView | null>(null);
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<Submitting>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      const body = (await response.json()) as GameStateView | ApiErrorBody;

      if (!mountedRef.current) return;

      if (!response.ok) {
        const message = 'error' in body ? body.error.message : 'Could not refresh the game state.';
        // initialLoadError owns the no-state screen; refreshError keeps the
        // last good state visible after a later polling failure.
        setInitialLoadError(message);
        setRefreshError(message);
        return;
      }
      setState(body as GameStateView);
      setRefreshError(null);
      setInitialLoadError(null);
    } catch {
      if (!mountedRef.current) return;
      // Keep the last known state on screen; a dropped poll is not a dead app.
      const message = 'Lost contact with the server. Retrying…';
      setInitialLoadError(message);
      setRefreshError(message);
    }
  }, []);

  const activeId = state?.activePrediction?.id ?? null;
  const serverSecondsRemaining = state?.activePrediction?.secondsRemaining ?? null;

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const pollInterval = activeId ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    const timer = setInterval(() => {
      // A hidden tab cannot show a result. Resume immediately when it becomes
      // visible instead of creating background request and database traffic.
      if (!document.hidden) void load();
    }, pollInterval);
    const onVisibilityChange = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeId, load]);

  // Countdown: resynchronised from every poll response, ticked locally in
  // between. Purely informational (see rule 2 above).
  useEffect(() => {
    if (serverSecondsRemaining === null) {
      setSecondsLeft(null);
      return;
    }
    setSecondsLeft(serverSecondsRemaining);
    const timer = setInterval(() => {
      setSecondsLeft((current) => (current === null ? null : Math.max(0, current - 1)));
    }, 1_000);
    return () => clearInterval(timer);
  }, [activeId, serverSecondsRemaining]);

  const submit = useCallback(
    async (direction: 'up' | 'down') => {
      setSubmitting(direction);
      setActionError(null);
      try {
        const response = await fetch('/api/predictions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The only thing the client is allowed to say. No player id, no
          // price, no timestamp — the server ignores anything else.
          body: JSON.stringify({ direction }),
        });
        const body = (await response.json()) as GameStateView | ConflictBody | ApiErrorBody;

        if (!mountedRef.current) return;

        if (response.status === 409 && 'state' in body) {
          // Someone already had an open prediction (e.g. two tabs). The server
          // returns the current state so the UI resynchronises immediately.
          setState(body.state);
          setActionError(
            'You already have an open prediction. Showing the one in progress.',
          );
          return;
        }
        if (!response.ok) {
          setActionError('error' in body ? body.error.message : 'Could not place the prediction.');
          return;
        }
        setState(body as GameStateView);
      } catch {
        if (mountedRef.current) {
          setActionError('Could not reach the server. Please try again.');
        }
      } finally {
        if (mountedRef.current) setSubmitting(null);
      }
    },
    [],
  );

  const activePrediction = state?.activePrediction ?? null;
  const resolutionPending =
    activePrediction !== null && (secondsLeft ?? activePrediction.secondsRemaining) === 0;

  const lastResult = useMemo(() => {
    if (!state?.latestPrediction) return null;
    // Only show a result once it is the finished thing on screen — an active
    // prediction takes precedence, and a pending row is not a result.
    if (state.activePrediction) return null;
    return state.latestPrediction.status === 'resolved' ? state.latestPrediction : null;
  }, [state?.latestPrediction, state?.activePrediction]);

  const priceUnavailable = state?.marketUnavailable ?? false;
  const canPredict = Boolean(state) && !activePrediction && !priceUnavailable && !submitting;

  if (!state && !initialLoadError) {
    return (
      <main className="page" aria-busy="true">
        <div className="loading-mark" aria-hidden="true">₿</div>
        <p className="blocked-hint" role="status">Opening the market…</p>
        <div className="skeleton skeleton--hero" />
        <div className="skeleton" />
      </main>
    );
  }

  if (!state) {
    return (
      <main className="page">
        <div className="card status" role="alert">
          <span className="section-label">Connection issue</span>
          <h1 className="status__headline">Could not load the game</h1>
          <p className="status__detail">{initialLoadError}</p>
          <button type="button" className="retry" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  const score = state.player.score;

  return (
    <main className="page">
      {state.priceSource.simulated && (
        <div className="banner banner--simulated" role="note">
          <strong>Demo mode.</strong> These are simulated prices, not live market data
          (<code>{state.priceSource.name}</code>).
        </div>
      )}

      {refreshError && (
        <div className="banner banner--error" role="alert">
          <span>{refreshError}</span>
          <button type="button" className="banner__action" onClick={() => void load()}>
            Retry now
          </button>
        </div>
      )}

      <header className="header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">₿</span>
          <div>
            <span className="eyebrow">BTC / USD · 60-second minimum</span>
            <h1 className="header__title">Up or down from here?</h1>
            <p className="header__subtitle">
              Choose a direction. The server settles against a later changed market quote.
            </p>
          </div>
        </div>
        <div className="score" aria-label={`Your score: ${score}`}>
          <span className="score__label">Score</span>
          <span
            className={`score__value ${score > 0 ? 'score__value--positive' : ''} ${
              score < 0 ? 'score__value--negative' : ''
            }`}
          >
            {score > 0 ? `+${score}` : score}
          </span>
        </div>
      </header>

      <section className="card price" aria-label="Latest BTC/USD market price">
        <div className="price__topline">
          <span className="price__label">Live reference price</span>
          <span className={`market-status ${priceUnavailable ? 'market-status--offline' : ''}`}>
            <span className="market-status__dot" aria-hidden="true" />
            {priceUnavailable ? 'Feed offline' : 'Market live'}
          </span>
        </div>
        {priceUnavailable || !state.market ? (
          <>
            <span className="price__value price__value--unavailable">Price unavailable</span>
            <span className="price__meta">
              The price feed is not responding. Your score is safe and you can still see an open
              prediction — predictions are paused until a price is available.
            </span>
          </>
        ) : (
          <>
            <span className="price__value">{formatUsd(state.market.price)}</span>
            <span className="price__meta">
              {formatTime(state.market.priceAt)} · {state.market.source}
            </span>
          </>
        )}
      </section>

      <div>
        {lastResult && <ResultCard result={lastResult} />}

        {activePrediction && (
          <Card>
            <PredictionPending
              prediction={activePrediction}
              secondsLeft={secondsLeft ?? activePrediction.secondsRemaining}
              resolutionPending={resolutionPending}
            />
          </Card>
        )}
      </div>

      {actionError && (
        <div className="banner banner--error" role="alert">
          <span>{actionError}</span>
          <button type="button" className="banner__dismiss" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <section className="choices" aria-label="Make a prediction">
        <button
          type="button"
          className="choice choice--up"
          onClick={() => void submit('up')}
          disabled={!canPredict}
          aria-describedby="choice-help"
        >
          <span className="choice__topline">
            <span className="choice__hint">Predict higher</span>
            <span className="choice__arrow" aria-hidden="true">↗</span>
          </span>
          <span className="choice__label">{submitting === 'up' ? 'Placing…' : 'Higher'}</span>
          <span className="choice__detail">BTC finishes above entry</span>
        </button>
        <button
          type="button"
          className="choice choice--down"
          onClick={() => void submit('down')}
          disabled={!canPredict}
          aria-describedby="choice-help"
        >
          <span className="choice__topline">
            <span className="choice__hint">Predict lower</span>
            <span className="choice__arrow" aria-hidden="true">↘</span>
          </span>
          <span className="choice__label">{submitting === 'down' ? 'Placing…' : 'Lower'}</span>
          <span className="choice__detail">BTC finishes below entry</span>
        </button>
      </section>

      <p className="blocked-hint" id="choice-help">
        {submitting
          ? 'Sending your prediction to the server…'
          : activePrediction
            ? 'You have an open prediction. You can play again as soon as it resolves.'
            : priceUnavailable
              ? 'Waiting for the price feed before accepting predictions.'
              : lastResult
                ? 'Place your next prediction whenever you are ready.'
                : 'Entry price and timing are recorded by the server.'}
      </p>

      <footer className="footer">
        <div className="footer__facts" aria-label="Game guarantees">
          <span>Server-authoritative</span>
          <span>One open prediction</span>
          <span>Exact decimal prices</span>
        </div>
        <p>
          Settlement starts after at least 60 seconds and may wait for a changed price.
          This page can be closed safely. Prices from {state.priceSource.name}.
        </p>
      </footer>
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card status">{children}</div>;
}

function PredictionPending({
  prediction,
  secondsLeft,
  resolutionPending,
}: {
  prediction: ActivePredictionView;
  secondsLeft: number;
  resolutionPending: boolean;
}) {
  const progress = Math.max(0, Math.min(100, (secondsLeft / MIN_WAIT_SECONDS) * 100));

  return (
    <>
      <span className="section-label">Open prediction</span>
      <div className="countdown">
        <span className="status__headline">
          {resolutionPending ? 'Settling…' : `You predicted ${prediction.direction === 'up' ? 'higher' : 'lower'}`}
        </span>
        <span className="countdown__value">
          {resolutionPending ? '00:00' : formatCountdown(secondsLeft)}
        </span>
      </div>

      <div className="progress" aria-hidden="true">
        <div className="progress__bar" style={{ width: `${resolutionPending ? 100 : progress}%` }} />
      </div>

      <p className="status__detail">{prediction.explanation}</p>

      <dl className="details">
        <dt>Your entry price</dt>
        <dd>{formatUsd(prediction.entryPrice)}</dd>
        <dt>Entry recorded at</dt>
        <dd>{formatTime(prediction.entryPriceAt)}</dd>
      </dl>
    </>
  );
}

function ResultCard({ result }: { result: NonNullable<GameStateView['latestPrediction']> }) {
  const won = result.outcome === 'win';
  return (
    <div className={`result ${won ? 'result--win' : 'result--loss'}`} role="status">
      <span className="section-label">Round settled</span>
      <h2 className="result__headline">
        {won ? 'You won' : 'You lost'}
        <span className="result__delta">{won ? '+1 point' : '−1 point'}</span>
      </h2>
      <dl className="details">
        <dt>Your prediction</dt>
        <dd>{result.direction === 'up' ? 'Higher' : 'Lower'}</dd>
        <dt>Entry price</dt>
        <dd>{formatUsd(result.entryPrice)}</dd>
        <dt>Settlement price</dt>
        <dd>{result.settlementPrice ? formatUsd(result.settlementPrice) : '—'}</dd>
        <dt>Resolved at</dt>
        <dd>{result.resolvedAt ? formatTime(result.resolvedAt) : '—'}</dd>
      </dl>
    </div>
  );
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
