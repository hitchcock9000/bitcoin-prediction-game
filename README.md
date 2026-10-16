# Bitcoin prediction game

## 1. What I built

This is a small BTC/USD prediction game built with React, Next.js, TypeScript
and PostgreSQL. A player chooses whether the price will be higher or lower after
at least 60 seconds. A correct prediction adds one point; a wrong one removes
one.

**Live demo:** https://bitcoin-prediction-game-khaki.vercel.app

I kept the browser deliberately untrusted. It submits `up` or `down` and renders
the state returned by the server. The server owns the player identity, prices,
timestamps, result and score changes.

The deployed app uses real BTC/USD quotes from Coinbase Exchange. It runs on
Vercel Hobby with Neon Postgres and a cron-job.org fallback, all on free tiers.

For the longer reasoning trail, see [DECISIONS.md](DECISIONS.md).

## 2. How the game works

1. On the first request, the server creates an anonymous player and stores the
   player ID in a signed, `HttpOnly` cookie.
2. The player chooses **Higher** or **Lower**. That direction is the only game
   input accepted from the browser.
3. The server fetches a fresh Coinbase quote and stores the price, provider
   timestamp and trade ID. PostgreSQL supplies the prediction creation time.
4. A player can have only one pending prediction. A partial unique index in
   PostgreSQL enforces that rule even when requests race.
5. After 60 seconds, a settlement sweep asks Coinbase for a new quote. The quote
   must be fresh, later than the entry quote and different from the entry price.
6. The prediction and score are updated together in one SQL statement. If two
   settlement attempts overlap, only one can change the row and score.

An unavailable, stale, future-dated or unchanged quote leaves the prediction
pending. I prefer an explicit wait to guessing a result.

The UI polls `GET /api/state` every three seconds while a prediction is active
and every ten seconds while idle. Hidden tabs pause polling and refresh as soon
as they become visible. On Vercel, a state request also runs a bounded
settlement sweep, so an active player normally sees the result soon after the
60-second threshold. A protected cron job calls `POST /api/settle` every 15
minutes as a fallback when nobody has the game open.

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

If you prefer Docker for the database:

```bash
docker run --rm \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=bpg_dev \
  postgres:17
```

The minimum local configuration is:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bpg_dev
PLAYER_COOKIE_SECRET=replace-with-at-least-32-random-characters
```

Coinbase is the default price provider. The full configuration, including the
development-only simulated provider, is documented in [.env.example](.env.example).

## 4. The main engineering decisions

### The server decides; React displays

The browser never sends a player ID, price, timestamp, result or score change.
This keeps the trust boundary easy to explain: the client can ask to play up or
down, but it cannot influence how the round is measured.

### PostgreSQL enforces the rules that must survive concurrency

The application performs friendly checks, but it does not rely on a
check-then-insert sequence. PostgreSQL enforces one pending prediction per
player, complete settlement data, the 60-second minimum, quote ordering and the
relationship between price movement and outcome.

Prices are stored as `NUMERIC(18,8)` and compared as decimal strings in the
domain layer. They are never converted to JavaScript floating-point values for
scoring.

### Settlement and scoring are one atomic operation

The settlement query updates only a prediction that is still `pending`. The
score update is driven by the row returned from that update. A duplicate or
racing attempt therefore becomes a no-op instead of changing the score twice.

### Uncertain market data does not produce a result

Coinbase provides the price, timestamp and trade ID. Entry and settlement have
separate freshness checks. If the provider is unavailable or the quote cannot
be ordered confidently, the prediction remains pending. An unchanged price is
also pending because it is neither a win nor a loss under the game rules.

### The free deployment has two settlement triggers

Vercel functions cannot host a dependable in-process timer. Active play uses a
request-triggered sweep; cron-job.org provides a 15-minute background fallback.
Both call the same settlement function. Overlapping calls in one server
instance share the same sweep; the database still makes cross-instance races
safe. This keeps hosting at €0, with an honest latency trade-off for idle games.

## 5. Testing

The important tests use a real PostgreSQL database because mocks cannot prove a
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

The deployed version was verified on 16 October 2026 with 170 passing tests.
The final verification pass produced 176 passing tests across the same 10
files, plus typecheck, lint and a production build. The added coverage checks
malformed cookies, identity retention after a provider failure, overlapping
sweeps within and across server instances, concurrent prediction conflicts and
the PostgreSQL snapshot edge case during concurrent player creation.

The deployment verification also included:

- concurrent coverage for 20 prediction creations, 10 settlement attempts, and
  an overlapping state-request/cron sweep;
- a real public round using Coinbase and a separate cron-only settlement check.

The test suite covers the pure settlement policy, Coinbase parsing, signed
identity cookies, HTTP responses, database constraints, score persistence and
concurrent settlement. `scripts/smoke.mjs` provides an additional full HTTP
journey for the local/container mode.

Pull requests to `main` run the same typecheck, lint, test and build checks in
GitHub Actions against an isolated PostgreSQL 17 service.

## 6. Deployment

The public deployment is:

- **Web:** Vercel Hobby
- **Database:** Neon Free, Frankfurt region
- **Market data:** Coinbase Exchange public BTC/USD ticker
- **Background fallback:** cron-job.org Free, every 15 minutes

The in-process scheduler is forced off when `VERCEL=1`. Vercel uses the pooled
Neon URL with a small connection pool; migrations use the direct URL. The cron
endpoint requires a separate secret in the `x-settlement-secret` header.

The deployment checks recorded on 16 October 2026 went beyond provider
dashboards:

- `/api/health` reported the database up and Coinbase with `simulated: false`;
- a live prediction stayed pending before 60 seconds and then settled from a
  later Coinbase quote;
- repeated reads kept the same result and score;
- an external cron `POST /api/settle` returned 200 and resolved a due prediction
  with no intervening `/api/state` request.

No paid plan or add-on is enabled.

## 7. Trade-offs and what I'd improve

- **Idle settlement is delayed.** With no browser traffic, a prediction waits
  for the next 15-minute cron run. That later quote can change the outcome. This
  is not a claim to capture the exact market price at second 60.
- **A flat price can remain pending indefinitely.** That follows the chosen
  interpretation that an unchanged price is neither a win nor a loss. A real
  product would need an explicit timeout or draw rule.
- **Anonymous identity is not authentication.** The signed cookie prevents
  impersonating a known player, but clearing it creates a new player.
- **There is no rate limiter.** The unique index limits each player to one open
  prediction, but it does not limit request volume.
- **The score is stored as well as derivable.** I would add a reconciliation job
  if this moved beyond a take-home exercise.
- **The price comes from one venue.** A broader product might use a documented
  cross-exchange index.
- **Creation retries do not use an idempotency key.** The database prevents two
  pending rows, and the second request returns the current conflict state. For a
  stricter retry contract, I would add a client-generated request ID with a
  unique constraint and replay the original response.
- **Browser testing could go further.** The API and complete HTTP flow are
  covered, but I would add a small Playwright suite for focus behaviour,
  hydration and the main mobile interaction path.

Those are conscious limits for a half-day assignment, not claims that the same
shape should be used unchanged at higher traffic.
