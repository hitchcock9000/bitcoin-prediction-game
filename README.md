# Bitcoin prediction game

## 1. What I built

This is a one-minute BTC/USD prediction game built with React, Next.js,
TypeScript and PostgreSQL. A player chooses **Higher** or **Lower**. A correct
prediction adds one point; a wrong one removes one.

**Live demo:** https://bitcoin-prediction-game-khaki.vercel.app

I kept the browser deliberately untrusted. It submits `up` or `down` and renders
the state returned by the server. The server owns the player identity, prices,
timestamps, result and score changes.

The deployed app uses real Coinbase Exchange prices. It runs on Vercel Hobby
with Neon Postgres and a cron-job.org fallback, all on free tiers.

## 2. How the game works

1. The first request creates an anonymous player. Its ID is stored in a signed,
   `HttpOnly` cookie.
2. The player submits only a direction. The server fetches and stores a fresh
   Coinbase price, provider timestamp and trade ID; PostgreSQL supplies the
   prediction timestamp.
3. A partial unique index allows one pending prediction per player, including
   when two requests race.
4. After at least 60 seconds, settlement asks Coinbase for another quote. It
   must be fresh, later than the entry quote and different from the entry price.
5. The prediction and score are updated together in one SQL statement. Racing
   settlement attempts can therefore score the round only once.

An unavailable, stale, future-dated or unchanged quote leaves the prediction
pending. I prefer an explicit wait to guessing a result.

While a round is active, the UI polls `GET /api/state` every three seconds. On
Vercel, that request also runs a bounded settlement sweep, so an active player
normally sees the result shortly after the threshold. The protected
`POST /api/settle` endpoint is available for an external cron fallback when
nobody has the game open.

## 3. How to run it locally

You need Node.js 20.11 or newer and PostgreSQL 13 or newer.

```bash
git clone https://github.com/hitchcock9000/bitcoin-prediction-game.git
cd bitcoin-prediction-game
npm install

cp .env.example .env
# Set DATABASE_URL and generate PLAYER_COOKIE_SECRET with:
# openssl rand -base64 48

npm run db:migrate
npm run dev
```

Open http://localhost:3000.

For a local database with Docker:

```bash
docker run --rm \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=bpg_dev \
  postgres:17
```

The minimum configuration is:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bpg_dev
PLAYER_COOKIE_SECRET=replace-with-at-least-32-random-characters
```

Coinbase is the default provider. The development-only simulated provider and
the remaining options are documented in [.env.example](.env.example).

## 4. The main engineering decisions

### The server decides; React displays

The browser never sends a player ID, price, timestamp, result or score change.
It can ask to play up or down, but it cannot influence how the round is measured.

### PostgreSQL owns the concurrency guarantees

Friendly application checks are not enough when requests race. PostgreSQL
enforces one pending prediction per player, complete settlement data, the
60-second minimum, quote ordering and consistency between movement and outcome.

Prices are stored as `NUMERIC(18,8)` and compared as decimal strings. Scoring
never converts them to JavaScript floating-point values.

### Settlement and scoring are atomic

The settlement query updates only a prediction that is still `pending`. The
score update depends on the row returned by that update, in the same statement.
A repeated or racing attempt becomes a no-op instead of scoring twice.

### Uncertain market data does not produce a result

Entry and settlement have separate freshness checks. If Coinbase is unavailable
or the quote cannot be ordered confidently, the round stays pending. An
unchanged price also stays pending because it is neither a win nor a loss under
the chosen rules.

### Serverless hosting needs two settlement triggers

Vercel functions cannot own a dependable in-process timer. Active play uses a
request-triggered sweep; a secret-protected `POST /api/settle` endpoint is
available for an external cron fallback. Both triggers call the same
settlement code. PostgreSQL keeps cross-instance overlap safe, while
overlapping calls inside one warm instance share the same sweep.

## 5. Testing

The important integration tests use real PostgreSQL. Mocks cannot prove a
partial unique index, a `CHECK` constraint or concurrent update behaviour.

Start an isolated test database:

```bash
docker run --rm \
  -p 55432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=bpg_test \
  postgres:17
```

Then run:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/bpg_test npm test
npm run typecheck
npm run lint
npm run build
```

The current suite has **176 tests across 10 files**. It covers the settlement
policy, decimal handling, Coinbase parsing, signed cookies, HTTP contracts,
database constraints, score persistence, provider failures and concurrent
creation and settlement. `scripts/smoke.mjs` adds a full HTTP journey against a
running app.

Pull requests to `main` run tests, typecheck, lint and the production build in
GitHub Actions with an isolated PostgreSQL 17 service.

## 6. Deployment

- **Web:** Vercel Hobby
- **Database:** Neon Free, Frankfurt
- **Market data:** Coinbase Exchange BTC/USD ticker
- **External background fallback:** the deployed demo uses cron-job.org Free on
  a 15-minute schedule; that schedule is configured outside this repository.

The in-process scheduler is disabled on Vercel. Application traffic uses the
pooled Neon URL with a small connection pool; migrations use the direct URL.
The cron endpoint requires a separate secret in the `x-settlement-secret`
header. This repository provides the endpoint, not the external cron schedule.

The public deployment was checked with a real Coinbase-backed round and a
separate cron-only settlement. The health endpoint reports the database up,
Coinbase active with `simulated: false`, and whether the external-trigger
secret is configured. The health endpoint does not verify the cron schedule.

## 7. Trade-offs and what I'd improve

- **Idle settlement can be late.** Without browser traffic, a round waits for
  the next 15-minute cron run. That later quote can change the result; this game
  does not promise the market price at exactly second 60.
- **A flat price can remain pending.** The chosen rule treats no movement as
  neither a win nor a loss. A real product needs a timeout or draw rule.
- **Anonymous identity is not authentication.** The signature prevents choosing
  another known player ID, but clearing the cookie creates a new player.
- **There is no rate limiter.** The unique index limits open rounds per player,
  not request volume.
- **Stored scores need reconciliation at larger scale.** Predictions are the
  audit trail, so I would periodically compare them with `players.score`.
- **One exchange defines the price.** A broader product might use a documented
  cross-exchange index.
- **Creation has no idempotency key.** Duplicate pending rounds are prevented,
  but stricter retry semantics would use a client request ID and replay the
  original response.
- **Browser coverage is still light.** I would add a small Playwright suite for
  focus behaviour, hydration and the main mobile path.

These are deliberate limits for a half-day assignment. The next step would be
to clarify the product semantics before adding infrastructure.
