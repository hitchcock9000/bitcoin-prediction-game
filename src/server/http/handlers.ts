import { timingSafeEqual } from 'node:crypto';
import { compareDecimal } from '@/domain/decimal';
import { describePendingReason } from '@/domain/rules';
import type { PriceProvider } from '@/domain/types';
import {
  PredictionAlreadyActiveError,
  PriceUnavailableError,
  type GameService,
  type PlayerState,
} from '../game/service';
import type { GameStore, PredictionRecord } from '../game/store';
import {
  PLAYER_COOKIE_NAME,
  createPlayerToken,
  readCookie,
  serializePlayerCookie,
  verifyPlayerToken,
} from '../identity';
import { runSettlementSweep } from '../settlement/runner';
import {
  toActivePredictionView,
  toLatestPredictionView,
  toMarketView,
  type GameStateView,
  type MarketView,
} from './view';

/**
 * HTTP handlers.
 *
 * Deliberately plain functions: they take a `Request` and return a `Response`,
 * with no import from `next/headers`. Two reasons:
 *
 * 1. No business rule lives here. These functions resolve identity, validate
 *    input shape, call the service or the settlement sweep, and map domain
 *    errors onto status codes. Everything that decides a game outcome is in
 *    `src/domain` or `src/server/game`.
 * 2. They can be tested as real HTTP semantics — status codes, cookies, JSON
 *    bodies — without booting a server or depending on framework internals.
 */

/**
 * The prediction request body is `{"direction":"up"}` — about 20 bytes. A
 * generous ceiling keeps a large upload from being buffered and parsed into
 * memory before any rule gets a look at it.
 *
 * Found by review rather than by design: a 2 MB body was accepted with 201.
 */
const MAX_PREDICTION_BODY_BYTES = 1024;

export interface HandlerDeps {
  store: GameStore;
  service: GameService;
  /**
   * Provider used only to display a price. May be a short-TTL cache.
   * Never used to create or settle a prediction.
   */
  displayProvider: PriceProvider;
  /** Provider used by settlement. Always queried live. */
  settlementProvider: PriceProvider;
  scheduler: { enabled: boolean; running: () => boolean };
  settlementSecret: string | null;
  cookieSecret: string;
  cookieSecure: boolean;
  cookieSameSite?: 'Lax' | 'Strict' | 'None';
  now?: () => Date;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface Handlers {
  handleState: (request: Request) => Promise<Response>;
  handleCreatePrediction: (request: Request) => Promise<Response>;
  handleSettle: (request: Request) => Promise<Response>;
  handleHealth: (request: Request) => Promise<Response>;
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});

  /**
   * Identity comes only from the signed cookie. `POST /api/predictions` reads
   * `direction` from the body and nothing else — a `playerId`, `score`,
   * `price` or timestamp in the payload is ignored by construction, because
   * there is no code path that reads them.
   */
  function resolveIdentity(request: Request, currentTime: Date): { playerId: string; setCookie: string | null } {
    const token = readCookie(request.headers.get('cookie'), PLAYER_COOKIE_NAME);
    const verified = verifyPlayerToken(token, deps.cookieSecret, currentTime);
    if (verified) return { playerId: verified.playerId, setCookie: null };

    const { playerId, token: issued } = createPlayerToken(deps.cookieSecret, currentTime);
    return {
      playerId,
      setCookie: serializePlayerCookie(issued, {
        secure: deps.cookieSecure,
        sameSite: deps.cookieSameSite,
        now: currentTime,
      }),
    };
  }

  async function readMarket(): Promise<{ market: MarketView | null; unavailable: boolean }> {
    try {
      const quote = await deps.displayProvider.getQuote();
      return { market: toMarketView(quote, deps.displayProvider.simulated), unavailable: false };
    } catch (error) {
      // A missing price must not prevent the player from seeing their score or
      // their open prediction.
      log('display_quote_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return { market: null, unavailable: true };
    }
  }

  /**
   * User-facing explanation for why an open prediction has not resolved yet.
   *
   * This is presentation, not scoring: the authoritative reasons are produced by
   * `decideSettlement` during a sweep and are recorded there. Here we only need
   * to tell the player what they are waiting for, using the same wording, and
   * the case it cannot know about is the one where the sweep is about to settle.
   */
  function explainPending(
    prediction: PredictionRecord,
    market: { market: MarketView | null; unavailable: boolean },
    currentTime: Date,
  ): string {
    const deadline = prediction.createdAt.getTime() + 60_000;
    if (currentTime.getTime() < deadline) return describePendingReason('too_early');
    if (market.unavailable || market.market === null) {
      return describePendingReason('provider_unavailable');
    }
    if (compareDecimal(market.market.price, prediction.entryPrice) === 0) {
      return describePendingReason('price_unchanged');
    }
    // The price has moved and the wait is over: the sweep will settle this on
    // its next tick. We deliberately do not show an outcome here — only the
    // server's own settlement may decide one.
    return 'The price has moved — finalising your result.';
  }

  async function buildStatePayload(playerId: string, currentTime: Date): Promise<GameStateView> {
    const [state, market] = await Promise.all([
      deps.service.getPlayerState(playerId),
      readMarket(),
    ]);

    return {
      player: { score: state.player.score },
      market: market.market,
      marketUnavailable: market.unavailable,
      activePrediction: state.activePrediction
        ? toActivePredictionView(state.activePrediction, currentTime, explainPending(state.activePrediction, market, currentTime))
        : null,
      latestPrediction: state.latestPrediction ? toLatestPredictionView(state.latestPrediction) : null,
      serverTime: currentTime.toISOString(),
      priceSource: {
        name: deps.displayProvider.name,
        simulated: deps.displayProvider.simulated,
      },
    };
  }

  function json(
    body: unknown,
    options: { status?: number; setCookie?: string | null } = {},
  ): Response {
    const headers = new Headers({
      'content-type': 'application/json; charset=utf-8',
      // Game state is per-player and changes constantly; nothing in between
      // should ever cache it.
      'cache-control': 'no-store',
    });
    if (options.setCookie) headers.append('set-cookie', options.setCookie);
    return new Response(JSON.stringify(body), { status: options.status ?? 200, headers });
  }

  function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
    return json({ error: { code, message, ...extra } }, { status });
  }

  return {
    async handleState(request: Request): Promise<Response> {
      const currentTime = now();
      try {
        const identity = resolveIdentity(request, currentTime);
        const payload = await buildStatePayload(identity.playerId, currentTime);
        return json(payload, { setCookie: identity.setCookie });
      } catch (error) {
        log('state_failed', { message: error instanceof Error ? error.message : String(error) });
        return errorResponse(500, 'internal_error', 'Could not load the game state. Please retry.');
      }
    },

    async handleCreatePrediction(request: Request): Promise<Response> {
      const currentTime = now();

      // Two guards against an oversized body, because a single one is not
      // enough: a chunked upload can omit Content-Length entirely.
      //
      // 1. Declared length, checked *before* reading, so an honest client's
      //    2 MB upload is refused without being buffered.
      const declaredLength = request.headers.get('content-length');
      if (declaredLength !== null) {
        const bytes = Number(declaredLength);
        if (!Number.isFinite(bytes) || bytes < 0) {
          return errorResponse(400, 'invalid_request', 'Malformed Content-Length header.');
        }
        if (bytes > MAX_PREDICTION_BODY_BYTES) {
          return errorResponse(413, 'payload_too_large', 'Request body is too large.');
        }
      }

      // 2. Actual length, so a body without a declared length is still bounded.
      //    Honest caveat: this one runs after the body has been read, so it
      //    bounds what gets *parsed and processed* rather than what gets
      //    buffered. A hard memory bound for chunked uploads belongs at the
      //    platform proxy, which is where a real deployment enforces it.
      let rawBody: string;
      try {
        rawBody = await request.text();
      } catch {
        return errorResponse(400, 'invalid_request', 'Could not read the request body.');
      }
      if (rawBody.length > MAX_PREDICTION_BODY_BYTES) {
        return errorResponse(413, 'payload_too_large', 'Request body is too large.');
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return errorResponse(400, 'invalid_request', 'Expected a JSON body with a "direction" field.');
      }

      const direction = typeof body === 'object' && body !== null ? (body as { direction?: unknown }).direction : undefined;
      if (direction !== 'up' && direction !== 'down') {
        return errorResponse(400, 'invalid_request', 'Direction must be "up" or "down".');
      }

      const identity = resolveIdentity(request, currentTime);

      try {
        await deps.service.submitPrediction({ playerId: identity.playerId, direction });
        const payload = await buildStatePayload(identity.playerId, currentTime);
        return json(payload, { status: 201, setCookie: identity.setCookie });
      } catch (error) {
        if (error instanceof PredictionAlreadyActiveError) {
          // Return the full state so the UI can recover immediately instead of
          // guessing what happened.
          const payload = await buildStatePayload(identity.playerId, currentTime);
          return json(
            {
              error: {
                code: 'prediction_already_active',
                message: 'You already have an open prediction.',
              },
              state: payload,
            },
            { status: 409, setCookie: identity.setCookie },
          );
        }

        if (error instanceof PriceUnavailableError) {
          log('entry_refused', { reason: error.reason });
          return errorResponse(503, 'price_unavailable', error.message, { reason: error.reason });
        }

        log('prediction_failed', { message: error instanceof Error ? error.message : String(error) });
        return errorResponse(500, 'internal_error', 'Could not place the prediction. Please retry.');
      }
    },

    /**
     * Settlement trigger for an external scheduler (CloudWatch Events,
     * EventBridge, a cron container, or a human with curl).
     *
     * Exists so settlement does not *depend* on the in-process scheduler being
     * available — a serverless deployment can drive the same sweep instead.
     * Disabled entirely when no secret is configured.
     */
    async handleSettle(request: Request): Promise<Response> {
      if (!deps.settlementSecret) {
        return errorResponse(
          404,
          'settlement_endpoint_disabled',
          'The settlement endpoint is disabled. Set SETTLEMENT_SECRET to enable it.',
        );
      }

      const provided = request.headers.get('x-settlement-secret') ?? '';
      if (!secretsMatch(provided, deps.settlementSecret)) {
        return errorResponse(401, 'unauthorized', 'Invalid settlement secret.');
      }

      try {
        const result = await runSettlementSweep({
          store: deps.store,
          provider: deps.settlementProvider,
          log,
        });
        return json({
          examined: result.examined,
          settled: result.settled,
          stillPending: result.stillPending,
          providerAvailable: result.providerAvailable,
        });
      } catch (error) {
        log('manual_settle_failed', { message: error instanceof Error ? error.message : String(error) });
        return errorResponse(500, 'internal_error', 'Settlement sweep failed.');
      }
    },

    async handleHealth(): Promise<Response> {
      const databaseUp = await deps.store.ping();
      let pending: { pending: number; oldestPendingAgeSeconds: number | null } = {
        pending: 0,
        oldestPendingAgeSeconds: null,
      };
      if (databaseUp) {
        try {
          pending = await deps.store.getPendingStats();
        } catch (error) {
          log('pending_stats_failed', { message: error instanceof Error ? error.message : String(error) });
        }
      }

      return json(
        {
          ok: databaseUp,
          database: databaseUp ? 'up' : 'down',
          priceProvider: {
            name: deps.displayProvider.name,
            simulated: deps.displayProvider.simulated,
          },
          settlement: {
            schedulerEnabled: deps.scheduler.enabled,
            schedulerRunning: deps.scheduler.running(),
            externalTriggerConfigured: deps.settlementSecret !== null,
          },
          pending,
          serverTime: now().toISOString(),
        },
        { status: databaseUp ? 200 : 503 },
      );
    },
  };
}

/** Constant-time comparison, so the secret cannot be probed by timing. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type { PlayerState };
