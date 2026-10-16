import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGameStore } from '@/server/game/store';
import { createGameService } from '@/server/game/service';
import { createHandlers, type Handlers } from '@/server/http/handlers';
import { signPlayerToken } from '@/server/identity';
import { runSettlementSweep } from '@/server/settlement/runner';
import type { PriceProvider } from '@/domain/types';
import type { GameStateView, ConflictBody, ApiErrorBody } from '@/shared/api';
import {
  closeTestDatabase,
  getScore,
  insertBackdatedPrediction,
  newPlayerId,
  readPrediction,
  resetDatabase,
  testPool,
} from '../helpers/db';
import { failingProvider, fixedPrice, StubPriceProvider } from '../helpers/stubPriceProvider';

/**
 * HTTP-level tests.
 *
 * These call the real handlers with real `Request` and `Response` objects —
 * cookies, status codes, JSON bodies — with a stub price provider and the real
 * database. They cover the properties the browser contract depends on:
 * identity from the cookie, duplicate rejection, error mapping, and state
 * recovery after settlement.
 */
const COOKIE_SECRET = 'test-cookie-secret-that-is-long-enough-1234';
const SETTLEMENT_SECRET = 'test-settlement-secret';

function cookieFrom(response: Response): string | null {
  const header =
    typeof response.headers.getSetCookie === 'function'
      ? (response.headers.getSetCookie()[0] ?? null)
      : response.headers.get('set-cookie');
  if (!header) return null;
  // Keep only the name=value pair, as a browser would send it back.
  return header.split(';')[0] ?? null;
}

function makeHandlers(
  options: {
    provider?: PriceProvider;
    settlementProvider?: PriceProvider;
    settlementSecret?: string | null;
    log?: (event: string, data: Record<string, unknown>) => void;
  } = {},
): { handlers: Handlers; provider: PriceProvider; store: ReturnType<typeof createGameStore> } {
  const store = createGameStore(testPool());
  const provider = options.provider ?? fixedPrice('82000.00');
  const service = createGameService({ store, provider });

  const handlers = createHandlers({
    store,
    service,
    displayProvider: provider,
    settlementProvider: options.settlementProvider ?? provider,
    scheduler: { enabled: true, running: () => true },
    settlementSecret:
      options.settlementSecret === undefined ? SETTLEMENT_SECRET : options.settlementSecret,
    cookieSecret: COOKIE_SECRET,
    cookieSecure: false,
    log: options.log,
  });

  return { handlers, provider, store };
}

function stateRequest(cookie?: string | null): Request {
  return new Request('http://test.local/api/state', {
    headers: cookie ? { cookie } : {},
  });
}

function predictionRequest(
  body: unknown,
  cookie?: string | null,
  options: { raw?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request('http://test.local/api/predictions', {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

describe('HTTP API', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  describe('GET /api/state — identity', () => {
    it('issues a signed cookie to a first-time visitor and starts them at zero', async () => {
      const { handlers } = makeHandlers();

      const response = await handlers.handleState(stateRequest());
      const cookie = cookieFrom(response);

      expect(response.status).toBe(200);
      expect(cookie).toMatch(/^bpg_player=/);
      // Scoped properly and not reachable from JavaScript.
      const setCookie = response.headers.getSetCookie()[0] ?? '';
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');

      const body = (await response.json()) as GameStateView;
      expect(body.player.score).toBe(0);
      expect(body.activePrediction).toBeNull();
      expect(body.market?.price).toBe('82000.00');
    });

    it('recognises the same player on the next request', async () => {
      const { handlers } = makeHandlers();
      const first = await handlers.handleState(stateRequest());
      const cookie = cookieFrom(first);

      const second = await handlers.handleState(stateRequest(cookie));
      const body = (await second.json()) as GameStateView;

      expect(second.status).toBe(200);
      expect(body.player.score).toBe(0);
      // No new cookie is issued for a known player on every poll.
      expect(second.headers.get('set-cookie')).toBeNull();
    });

    it('ignores a forged cookie instead of adopting the identity it names', async () => {
      const { handlers } = makeHandlers();
      const victim = newPlayerId();
      await testPool().query('insert into players (id, score) values ($1, 99)', [victim]);

      // The signature does not cover this id, so the token is rejected and a
      // brand new identity is issued rather than trusting what was sent.
      const forged = `bpg_player=${victim}.${Date.now()}.not-a-real-signature`;
      const response = await handlers.handleState(stateRequest(forged));
      const body = (await response.json()) as GameStateView;

      expect(response.status).toBe(200);
      expect(body.player.score).toBe(0);
      expect(cookieFrom(response)).not.toContain(victim);
      expect(await getScore(victim)).toBe(99);
    });

    it('replaces a cookie with invalid percent-encoding instead of returning 500', async () => {
      const { handlers } = makeHandlers();
      const response = await handlers.handleState(
        stateRequest('bpg_player=%E0%A4%A'),
      );

      expect(response.status).toBe(200);
      expect(cookieFrom(response)).toMatch(/^bpg_player=/);
      expect(((await response.json()) as GameStateView).player.score).toBe(0);
    });

    it('never caches game state', async () => {
      const { handlers } = makeHandlers();
      const response = await handlers.handleState(stateRequest());
      expect(response.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('POST /api/predictions', () => {
    it('creates a prediction using the server price, not any client value', async () => {
      const { handlers, provider } = makeHandlers({ provider: fixedPrice('81000.50') });

      const response = await handlers.handleCreatePrediction(
        predictionRequest(
          {
            direction: 'up',
            // Everything below is ignored: there is no code path that reads it.
            playerId: newPlayerId(),
            score: 9999,
            entryPrice: '1.00',
            createdAt: '1999-01-01T00:00:00.000Z',
          },
          null,
        ),
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as GameStateView;
      expect(body.activePrediction?.direction).toBe('up');
      // The entry price is the provider's quote, trimmed for display.
      expect(body.activePrediction?.entryPrice).toBe('81000.50');
      expect(body.player.score).toBe(0);
      expect((provider as StubPriceProvider).calls).toBeGreaterThan(0);
    });

    it('rejects an invalid direction with 400', async () => {
      const { handlers } = makeHandlers();

      for (const body of [{ direction: 'sideways' }, { direction: 'UP' }, {}, { direction: 5 }]) {
        const response = await handlers.handleCreatePrediction(predictionRequest(body));
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiErrorBody).error.code).toBe('invalid_request');
      }
    });

    it('rejects an oversized body', async () => {
      // A prediction is ~20 bytes of JSON. A 2 MB body was previously accepted
      // and buffered; the review caught it.
      const { handlers } = makeHandlers();
      const response = await handlers.handleCreatePrediction(
        predictionRequest({ direction: 'up', padding: 'x'.repeat(2_000_000) }),
      );

      expect(response.status).toBe(413);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('payload_too_large');
    });

    it('rejects an oversized body from the declared Content-Length, before reading it', async () => {
      // The fast path a real HTTP client hits: the header is present, so the
      // body is refused without being buffered.
      const { handlers } = makeHandlers();
      const response = await handlers.handleCreatePrediction(
        new Request('http://test.local/api/predictions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '2000000' },
          body: JSON.stringify({ direction: 'up' }),
        }),
      );
      expect(response.status).toBe(413);
    });

    it('still accepts a body that is large for a reason but within the limit', async () => {
      const { handlers } = makeHandlers();
      const response = await handlers.handleCreatePrediction(
        predictionRequest({ direction: 'up', comment: 'x'.repeat(200) }),
      );
      expect(response.status).toBe(201);
    });

    it('rejects a malformed JSON body with 400', async () => {
      const { handlers } = makeHandlers();
      const response = await handlers.handleCreatePrediction(
        predictionRequest(null, null, { raw: '{ not json' }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects a second prediction for the same player with 409 and the current state', async () => {
      const { handlers } = makeHandlers();
      const cookie = cookieFrom(await handlers.handleState(stateRequest()));

      const first = await handlers.handleCreatePrediction(predictionRequest({ direction: 'up' }, cookie));
      expect(first.status).toBe(201);

      const second = await handlers.handleCreatePrediction(predictionRequest({ direction: 'down' }, cookie));
      expect(second.status).toBe(409);

      const body = (await second.json()) as ConflictBody;
      expect(body.error.code).toBe('prediction_already_active');
      // The state comes back so the UI can resynchronise without another round trip.
      expect(body.state.activePrediction?.direction).toBe('up');

      const { rows } = await testPool().query(
        `select count(*)::int as n from predictions where status = 'pending'`,
      );
      expect(rows[0].n).toBe(1);
    });

    it('refuses to create a prediction when no price is available', async () => {
      const { handlers } = makeHandlers({ provider: failingProvider('upstream down') });
      const cookie = cookieFrom(await handlers.handleState(stateRequest()));

      const response = await handlers.handleCreatePrediction(predictionRequest({ direction: 'up' }, cookie));

      expect(response.status).toBe(503);
      const body = (await response.json()) as ApiErrorBody;
      expect(body.error.code).toBe('price_unavailable');
      expect(body.error.reason).toBe('provider_unavailable');

      // Nothing was recorded: a round must never start from an unknown price.
      const { rows } = await testPool().query('select count(*)::int as n from predictions');
      expect(rows[0].n).toBe(0);
    });

    it('keeps a first-time player identity when entry fails', async () => {
      const { handlers } = makeHandlers({ provider: failingProvider('upstream down') });

      const first = await handlers.handleCreatePrediction(
        predictionRequest({ direction: 'up' }),
      );
      const cookie = cookieFrom(first);

      expect(first.status).toBe(503);
      expect(cookie).toMatch(/^bpg_player=/);

      const second = await handlers.handleCreatePrediction(
        predictionRequest({ direction: 'up' }, cookie),
      );
      expect(second.status).toBe(503);
      expect(second.headers.get('set-cookie')).toBeNull();

      const { rows } = await testPool().query('select count(*)::int as n from players');
      expect(rows[0].n).toBe(1);
    });
  });

  describe('state recovery and pending explanations', () => {
    it('reports the resolved result and updated score after settlement', async () => {
      const { handlers, store } = makeHandlers({ provider: fixedPrice('80000.00') });
      const cookie = cookieFrom(await handlers.handleState(stateRequest()));

      await handlers.handleCreatePrediction(predictionRequest({ direction: 'up' }, cookie));

      // Age the prediction so its 60 second window has elapsed, then let the
      // real sweep settle it — the same code path the scheduler runs.
      await testPool().query(
        `update predictions set created_at = now() - interval '61 seconds',
                               entry_price_at = now() - interval '61 seconds'`,
      );

      // The settlement quote is a genuinely later observation, so it carries a
      // higher trade id than the entry quote. A stub that reuses the entry's
      // trade id is correctly refused as "not a later quote".
      const sweep = await runSettlementSweep({ store, provider: fixedPrice('80100.00', 3_000_000) });
      expect(sweep.settled).toBe(1);

      const response = await handlers.handleState(stateRequest(cookie));
      const body = (await response.json()) as GameStateView;

      expect(body.player.score).toBe(1);
      expect(body.activePrediction).toBeNull();
      expect(body.latestPrediction?.status).toBe('resolved');
      expect(body.latestPrediction?.outcome).toBe('win');
      expect(body.latestPrediction?.settlementPrice).toBe('80100.00');
      expect(body.latestPrediction?.scoreDelta).toBe(1);
    });

    it('explains a wait that has not finished, without leaking internal codes', async () => {
      const { handlers } = makeHandlers();
      const cookie = cookieFrom(await handlers.handleState(stateRequest()));
      await handlers.handleCreatePrediction(predictionRequest({ direction: 'up' }, cookie));

      const response = await handlers.handleState(stateRequest(cookie));
      const body = (await response.json()) as GameStateView;

      expect(body.activePrediction?.secondsRemaining).toBeGreaterThan(50);
      expect(body.activePrediction?.explanation).toMatch(/60 second window/i);
      // No raw reason codes or HTTP jargon in user-facing copy.
      expect(body.activePrediction?.explanation).not.toMatch(/_|4\d\d|5\d\d/);
    });

    it('explains an open prediction whose price has not moved yet', async () => {
      const playerId = newPlayerId();
      // Same price at entry and now, window already elapsed.
      const { handlers } = makeHandlers({ provider: fixedPrice('80000.00') });
      const cookie = `bpg_player=${signFor(playerId)}`;

      await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 61 });

      const response = await handlers.handleState(stateRequest(cookie));
      const body = (await response.json()) as GameStateView;

      expect(body.activePrediction?.secondsRemaining).toBe(0);
      expect(body.activePrediction?.explanation).toMatch(/not moved/i);
    });

    it('says it is finalising once the price has moved, without revealing an outcome', async () => {
      const playerId = newPlayerId();
      const { handlers } = makeHandlers({
        provider: fixedPrice('80500.00'),
        // Display prices cannot decide the result when the live settlement
        // provider is unavailable, even though the displayed price moved.
        settlementProvider: failingProvider(),
      });
      const cookie = `bpg_player=${signFor(playerId)}`;

      await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 61 });

      const response = await handlers.handleState(stateRequest(cookie));
      const body = (await response.json()) as GameStateView;

      expect(body.activePrediction?.explanation).toMatch(/finalising/i);
      // The outcome is decided by the sweep, never by the display path.
      expect(body.latestPrediction?.outcome).toBeNull();
    });

    it('still reports score and the open prediction when the price feed is down', async () => {
      const playerId = newPlayerId();
      const { handlers } = makeHandlers({ provider: failingProvider() });
      const cookie = `bpg_player=${signFor(playerId)}`;
      await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 10 });

      const response = await handlers.handleState(stateRequest(cookie));
      const body = (await response.json()) as GameStateView;

      expect(response.status).toBe(200);
      expect(body.market).toBeNull();
      expect(body.marketUnavailable).toBe(true);
      expect(body.activePrediction).not.toBeNull();
    });
  });

  describe('GET /api/state — request-triggered settlement', () => {
    it('returns a due result and its score in the same state response', async () => {
      const playerId = newPlayerId();
      const { handlers } = makeHandlers({ provider: fixedPrice('80100.00') });
      const predictionId = await insertBackdatedPrediction({
        playerId, entryPrice: '80000.00', secondsAgo: 61,
      });
      const cookie = `bpg_player=${signFor(playerId)}`;

      const response = await handlers.handleState(stateRequest(cookie));
      const body = (await response.json()) as GameStateView;

      expect(response.status).toBe(200);
      expect(body.player.score).toBe(1);
      expect(body.activePrediction).toBeNull();
      expect(body.latestPrediction).toMatchObject({ status: 'resolved', outcome: 'win', scoreDelta: 1 });
      expect(await readPrediction(predictionId)).toMatchObject({ status: 'resolved', outcome: 'win' });
      // Refresh/retry uses the persisted result and cannot score it again.
      const again = await handlers.handleState(stateRequest(cookie));
      expect(((await again.json()) as GameStateView).player.score).toBe(1);
      expect(await getScore(playerId)).toBe(1);
    });

    it.each([
      { name: 'before 60 seconds', secondsAgo: 10, price: '80100.00' },
      { name: 'when the price is unchanged', secondsAgo: 61, price: '80000.00' },
    ])('keeps the prediction pending $name', async ({ secondsAgo, price }) => {
      const playerId = newPlayerId();
      const { handlers } = makeHandlers({ provider: fixedPrice(price) });
      const predictionId = await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo });

      const response = await handlers.handleState(stateRequest(`bpg_player=${signFor(playerId)}`));
      const body = (await response.json()) as GameStateView;

      expect(response.status).toBe(200);
      expect(body.player.score).toBe(0);
      expect(body.activePrediction).not.toBeNull();
      expect(await readPrediction(predictionId)).toMatchObject({ status: 'pending', outcome: null });
      expect(await getScore(playerId)).toBe(0);
    });

    it('keeps a due prediction pending and returns state during provider failure', async () => {
      const playerId = newPlayerId();
      const { handlers } = makeHandlers({ provider: failingProvider() });
      const predictionId = await insertBackdatedPrediction({
        playerId, entryPrice: '80000.00', secondsAgo: 61,
      });

      const response = await handlers.handleState(stateRequest(`bpg_player=${signFor(playerId)}`));
      const body = (await response.json()) as GameStateView;

      expect(response.status).toBe(200);
      expect(body.player.score).toBe(0);
      expect(body.activePrediction).not.toBeNull();
      expect(body.marketUnavailable).toBe(true);
      expect(await readPrediction(predictionId)).toMatchObject({ status: 'pending', outcome: null });
      expect(await getScore(playerId)).toBe(0);
    });

    it('logs a failed sweep while still returning persisted game state', async () => {
      const playerId = newPlayerId();
      const log = vi.fn();
      const { handlers, store } = makeHandlers({ log });
      const predictionId = await insertBackdatedPrediction({
        playerId, entryPrice: '80000.00', secondsAgo: 61,
      });
      const sweepQuery = vi.spyOn(store, 'listSweepable').mockRejectedValueOnce(new Error('Temporary sweep query failure'));
      try {
        const response = await handlers.handleState(stateRequest(`bpg_player=${signFor(playerId)}`));
        const body = (await response.json()) as GameStateView;
        expect(response.status).toBe(200);
        expect(body.player.score).toBe(0);
        expect(body.activePrediction).not.toBeNull();
        expect(await readPrediction(predictionId)).toMatchObject({ status: 'pending', outcome: null });
        expect(log).toHaveBeenCalledWith('request_settle_failed', { message: 'Temporary sweep query failure' });
      } finally {
        sweepQuery.mockRestore();
      }
    });

    it('shares an overlapping state and cron sweep inside one server instance', async () => {
      const playerId = newPlayerId();
      const settlementProvider = new StubPriceProvider(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return fixedPrice('80100.00').getQuote();
      });
      const { handlers } = makeHandlers({
        provider: fixedPrice('80100.00'),
        settlementProvider,
      });
      await insertBackdatedPrediction({
        playerId, entryPrice: '80000.00', secondsAgo: 61,
      });
      const cookie = `bpg_player=${signFor(playerId)}`;

      const [stateResponse, cronResponse] = await Promise.all([
        handlers.handleState(stateRequest(cookie)),
        handlers.handleSettle(new Request('http://test.local/api/settle', {
          method: 'POST',
          headers: { 'x-settlement-secret': SETTLEMENT_SECRET },
        })),
      ]);

      expect(stateResponse.status).toBe(200);
      expect(cronResponse.status).toBe(200);
      expect(settlementProvider.calls).toBe(1);
      expect(await getScore(playerId)).toBe(1);
    });

    it('scores exactly once when state and cron race across server instances', async () => {
      const playerId = newPlayerId();
      const provider = fixedPrice('80100.00');
      let release!: () => void;
      const bothSweepsReady = new Promise<void>(resolve => { release = resolve; });
      let arrivals = 0;
      const settlementProvider = new StubPriceProvider(async () => {
        // Both requests must have selected the pending row before either can
        // resolve it, exercising the database's conditional write race.
        arrivals += 1;
        if (arrivals === 2) release();
        await bothSweepsReady;
        return provider.getQuote();
      });
      // Separate handler graphs simulate two warm serverless instances. Their
      // in-process overlap guards cannot see each other, so the database still
      // has to make the write race safe.
      const firstInstance = makeHandlers({ provider, settlementProvider }).handlers;
      const secondInstance = makeHandlers({ provider, settlementProvider }).handlers;
      const predictionId = await insertBackdatedPrediction({
        playerId, entryPrice: '80000.00', secondsAgo: 61,
      });
      const cookie = `bpg_player=${signFor(playerId)}`;

      const responses = await Promise.all([
        firstInstance.handleState(stateRequest(cookie)),
        secondInstance.handleSettle(new Request('http://test.local/api/settle', {
          method: 'POST',
          headers: { 'x-settlement-secret': SETTLEMENT_SECRET },
        })),
      ]);

      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect(arrivals).toBe(2);
      expect(await getScore(playerId)).toBe(1);
      expect(await readPrediction(predictionId)).toMatchObject({ status: 'resolved', outcome: 'win' });
      const response = await firstInstance.handleState(stateRequest(cookie));
      const body = (await response.json()) as GameStateView;
      expect(body.player.score).toBe(1);
      expect(body.activePrediction).toBeNull();
    });
  });

  describe('POST /api/settle — external trigger', () => {
    it('is disabled when no secret is configured', async () => {
      const { handlers } = makeHandlers({ settlementSecret: null });
      const response = await handlers.handleSettle(new Request('http://test.local/api/settle', { method: 'POST' }));
      expect(response.status).toBe(404);
    });

    it('rejects a wrong secret', async () => {
      const { handlers } = makeHandlers();
      const response = await handlers.handleSettle(
        new Request('http://test.local/api/settle', {
          method: 'POST',
          headers: { 'x-settlement-secret': 'wrong' },
        }),
      );
      expect(response.status).toBe(401);
    });

    it('runs the sweep with the correct secret', async () => {
      const playerId = newPlayerId();
      const { handlers } = makeHandlers({ provider: fixedPrice('80100.00') });
      await insertBackdatedPrediction({ playerId, entryPrice: '80000.00', secondsAgo: 61 });

      const response = await handlers.handleSettle(
        new Request('http://test.local/api/settle', {
          method: 'POST',
          headers: { 'x-settlement-secret': SETTLEMENT_SECRET },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ examined: 1, settled: 1 });
      expect(await getScore(playerId)).toBe(1);
    });
  });

  describe('GET /api/health', () => {
    it('reports database, provider and settlement status', async () => {
      const { handlers } = makeHandlers();
      const response = await handlers.handleHealth(new Request('http://test.local/api/health'));
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        database: 'up',
        priceProvider: { name: 'stub:BTC-USD', simulated: true },
        settlement: { schedulerEnabled: true, schedulerRunning: true, externalTriggerConfigured: true },
      });
      // No secret material is ever returned.
      expect(JSON.stringify(body)).not.toContain(SETTLEMENT_SECRET);
      expect(JSON.stringify(body)).not.toContain(COOKIE_SECRET);
    });
  });
});

/** Mints a valid cookie value for a specific player id, for tests that need one. */
function signFor(playerId: string): string {
  // The real signing routine, so verification in the handler is genuinely exercised.
  return signPlayerToken(playerId, Date.now(), COOKIE_SECRET);
}
