# Bitcoin prediction game

> Deployment update (16 October 2026): the approved target is Vercel Hobby +
> Neon Free + cron-job.org Free, with no paid add-ons. The server now awaits a
> bounded settlement sweep on state requests; the 15-minute external cron is a
> fallback when no browser is open. The in-process scheduler is disabled on
> Vercel. Deployment is not yet verified; no public URL is claimed.
>
> A delayed sweep uses a later eligible market quote, so delay can affect the
> outcome, not just when the result appears. The original domain policy and
> database constraints are unchanged. Older container deployment instructions
> below remain an alternative, not the selected hosting plan.

Serverless-change checks (16 October 2026): typecheck, lint, all **170 tests**
against isolated real PostgreSQL, and production build passed. Tests include
overlapping state-request and authenticated cron settlement. Production-only
dependency audit: **zero vulnerabilities**. Development tooling still has audit
findings; this is not a claim that the entire dependency tree is clear.

A small web game: predict whether the market price of BTC/USD will be **higher**
or **lower** one minute from now. Correct predictions add a point, incorrect ones
subtract a point, and scores persist in PostgreSQL.

The interesting part of this assignment is not the UI. It is making the rules
hold when things are inconvenient: a player double-clicks, the tab closes, two
requests arrive at once, the price feed is down, the server restarts halfway
through a round. The server owns the game state; the browser only asks what to
show next.

> **Status.** The complete game — schema, settlement engine, HTTP API and UI — is
> implemented and verified locally, including the full loop end to end. The
> public deployment and the repository publication are the remaining steps. See
> [Current status](#current-status). Nothing in this README describes behaviour
> that has not been run.

---

## Table of contents

- [Current status](#current-status)
- [Core functionality](#core-functionality)
- [HTTP API](#http-api)
- [UI states](#ui-states)
- [Requirements and acceptance criteria](#requirements-and-acceptance-criteria)
- [Ambiguities and assumptions](#ambiguities-and-assumptions)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Game rules](#game-rules)
- [Settlement policy](#settlement-policy)
- [Data model](#data-model)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Database setup and migrations](#database-setup-and-migrations)
- [Running the application](#running-the-application)
- [Running tests](#running-tests)
- [Deployment](#deployment)
- [Trade-offs and limitations](#trade-offs-and-limitations)
- [Next improvements](#next-improvements)

---

## Current status

| Area | State |
| --- | --- |
| Database schema + migrations | Implemented, applied and tested against PostgreSQL 16.2 |
| Settlement engine (policy, sweep, scheduler) | Implemented, tested (including restart recovery and racing sweeps) |
| Game service (creation, state) | Implemented, tested |
| Price providers (Coinbase + simulated) | Implemented, parser tested against a captured live payload |
| Player identity (signed cookie) | Implemented, tested |
| HTTP API (`state`, `predictions`, `settle`, `health`) | Implemented, tested at HTTP level |
| UI (all eight states) | Implemented, served from the production build |
| Scheduler in the production process | Verified in `node .next/standalone/server.js` |
| Full game loop over HTTP | Verified end to end (`scripts/smoke.mjs`, 14/14 checks) |
| Public deployment | Not yet done — no URL is claimed |
| Repository published | Not yet done — branch pushed, PR open |

---

## Core functionality

1. A player opens the page and is given an anonymous, server-signed identity.
2. They see the latest BTC/USD price and their own score.
3. They choose **UP** or **DOWN**. The server records the entry price, the entry
   quote's timestamp and the creation time.
4. While a prediction is open, no further predictions are accepted.
5. Once at least 60 seconds have passed **and** the price has actually moved, the
   server resolves the prediction: the price being higher than the entry price is
   a win for UP and a loss for DOWN, and vice versa.
6. A win adds one point, a loss subtracts one point.

Settlement is driven by the server on a timer. It does not depend on the browser
remaining open, and it survives restarts.

### HTTP API

| Endpoint | Purpose | Notes |
| --- | --- | --- |
| `GET /api/state` | Score, latest price, open prediction, last result | Issues a signed player cookie on first contact |
| `POST /api/predictions` | Place a prediction | Body is `{"direction":"up"\|"down"}`; **everything else is ignored** |
| `POST /api/settle` | Run one settlement sweep | Requires `SETTLEMENT_SECRET`; disabled (404) when unset |
| `GET /api/health` | DB, provider and scheduler status | 503 when the database is unreachable |

Status codes: `201` created, `400` malformed direction, `409` already has an open
prediction (the body includes the current state so the UI can resync), `503` the
price feed is unavailable, `401`/`404` on the settle endpoint. All responses are
`cache-control: no-store`.

The prediction request body is the whole attack surface from the client's side:
the player says *up* or *down* and nothing else. There is no code path that reads
a player id, score, price or timestamp from a request, which is why "the client
cannot influence an outcome" is a structural property rather than a validation
rule that could be forgotten.

### UI states

Eight states, each rendered explicitly so a player is never left guessing:

| State | Treatment |
| --- | --- |
| Initial loading | Placeholder, `aria-busy` |
| Ready | Price with its timestamp, score, two buttons |
| Submitting | Button shows "Placing…", both disabled |
| Pending | Entry price, entry time, countdown, and a sentence explaining the wait |
| Won / Lost | Result card with entry price, settlement price, ±1, resolved time |
| Price unavailable | Price slot says so, predictions paused, score still visible |
| Recoverable error | Inline banner with a retry, last known state stays on screen |
| Simulated prices | Persistent "Demo mode" banner naming the provider |

The countdown is seeded from the server's `secondsRemaining` on every poll and
ticked locally in between. It is decoration: it triggers nothing and a wrong
client clock cannot change a result.

---

## Requirements and acceptance criteria

### Must-have (from the assignment)

| # | Requirement | How it is met | Verified by |
| --- | --- | --- | --- |
| 1 | Current player score is always visible | `GET /api/state` reads it from `players.score` | integration tests |
| 2 | Latest BTC/USD price in USD | Coinbase Exchange `/products/BTC-USD/ticker` | `tests/unit/coinbase.test.ts` |
| 3 | Player can predict UP or DOWN | `POST /api/predictions` with direction only | integration tests |
| 4 | Only one active prediction per player | Partial unique index on `(player_id) WHERE status = 'pending'` | DB constraint test, 20-way concurrency test |
| 5 | No new prediction until the open one resolves | Same index; `409` response | integration tests |
| 6 | Resolution requires ≥60s **and** a changed price | `decideSettlement` + `predictions_no_early_resolution` | 28 unit cases + integration tests |
| 7 | Correct prediction: +1 | Conditional update + `CHECK` | integration tests |
| 8 | Incorrect prediction: −1 | Same | integration tests |
| 9 | New players start at 0 | `players.score DEFAULT 0` | integration tests |
| 10 | Scores persist in a backend store | PostgreSQL, `players.score` | restart/returning-player tests |

### Nice-to-have

| Feature | State |
| --- | --- |
| Returning anonymous players keep their score | Implemented (signed 1-year cookie + persisted rows), tested |
| An open prediction survives a refresh or a restart | Implemented (the client is stateless; state comes from `/api/state`) |
| A countdown for the minimum wait | Planned (UI) |
| Clear loading, pending, won, lost and error states | Planned (UI) |
| Responsive, accessible UI | Planned (UI) |
| Additional monitoring | Partially: structured settlement logs + `/api/health` |

### Definition of done, as a checklist

- [x] New player starts with zero points
- [x] Prices come from a real provider (adapter implemented and parser tested against live payload)
- [x] Player can submit UP or DOWN
- [x] A second active prediction is rejected
- [x] Predictions cannot resolve before 60 seconds (enforced in code *and* in the schema)
- [x] Unchanged prices produce no result
- [x] Correct predictions add one point
- [x] Incorrect predictions subtract one point
- [x] Scores persist in PostgreSQL
- [x] Settlement cannot update the score twice (repeated and concurrent settlement tested)
- [x] UI states implemented and served from the production build
- [x] Full game loop verified over HTTP (`scripts/smoke.mjs`, 14/14)
- [x] Scheduler verified in the production process, and restart recovery demonstrated
- [ ] Publicly accessible deployment ← *pending, needs deployment credentials*
- [x] Repository is public
- [x] README, DECISIONS.md and WALKTHROUGH.md reflect the implementation
- [x] Critical tests run and reported
- [x] Known limitations disclosed

---

## Ambiguities and assumptions

The assignment is short, and several rules are open to interpretation. Each
ambiguity, the interpretation chosen, and the impact are recorded here. None of
these change the stated rules; they fill gaps the rules leave open.

| # | Ambiguity | Interpretation | Impact / trade-off |
| --- | --- | --- | --- |
| A1 | What if the price is unchanged after 60 seconds? | Stay pending until a later quote actually moves. Never scored as a win or a loss. | A prediction can stay open indefinitely on a flat market. This follows the rules literally ("the price has changed" is a condition of resolution, and unchanged must not be treated as win or loss); the cost is that the player waits. |
| A2 | Which quote counts as the settlement price? | The freshest quote the provider returns at the first sweep *at or after* 60 seconds, provided it is strictly newer than the entry quote and is not stale (≤30s old). | Settlement happens on the first sweep where a qualifying quote exists, so resolution is within one tick (≈5s) of eligibility. |
| A3 | What happens if the price provider is unavailable? | No outcome is produced. Entry is refused (no prediction created); settlement stays pending and retries. | Players cannot start a round during an outage. Preferred over reusing a stale price, which would silently settle against the wrong market. |
| A4 | What happens if the user closes the browser? | Nothing. State lives in the database; the sweep resolves the prediction with no client involvement. | None — this is the intended behaviour. |
| A5 | Two requests create a prediction at the same instant? | The partial unique index lets exactly one succeed; the other gets `409`. | Requires no client cooperation; verified with 20 concurrent inserts. |
| A6 | Settlement attempted twice, concurrently? | The conditional `UPDATE ... WHERE status = 'pending'` makes the second a no-op. The score moves once. | Verified with 10 concurrent settlements and two racing sweeps. |
| A7 | How is an anonymous player identified? | A random UUID minted by the server, returned in an HMAC-signed `HttpOnly` cookie. The client never supplies an id. | Clearing cookies loses the score. This is integrity, not authentication — see [D9](DECISIONS.md). |
| A8 | Whose clock decides when 60 seconds have passed? | The database's clock, since it owns `created_at` and validates `resolved_at`. | The app server and the database do not need synchronised clocks. The countdown in the UI is presentational only. |
| A9 | Is the price "changed" for a one-cent move? | Yes — any strictly greater or strictly smaller price counts. Exact decimal comparison, no minimum threshold. | The smallest possible move is rewarded. Chosen because the rules say *changed*, not *changed by X*, and because the price provider gives full precision. |
| A10 | Are points aggregate or per-player-per-round? | Cumulative per player, persisted forever. | No leaderboard or reset is implied by the assignment, so none is built. |
| A11 | Where does the entry price come from if the player has a slow connection? | The server's own provider call at the moment of creation. The client's displayed price is not used. | The price a player sees may differ slightly from the price they get, since a second can pass. The recorded entry price is shown back to them once the prediction is created. |
| A12 | Should predictions created before a provider change still settle? | Yes, and the entry source is recorded on each row so a mixed-source round is detectable and logged. | Avoids stranding predictions if `PRICE_PROVIDER` is changed while rounds are open. |

---

## Tech stack

| Concern | Choice | Why (short version) |
| --- | --- | --- |
| Language | TypeScript (strict) | Shared vocabulary between domain, API and UI; the price/score types are worth pinning down |
| Framework | Next.js 15 (App Router) | One process to deploy, route handlers for the API, React for the UI, no separate backend service to operate |
| UI | React 19 + hand-written CSS | The interface is a handful of states; a component library would be more setup than code |
| Database | PostgreSQL | Partial unique indexes, `CHECK` constraints and atomic conditional updates are the backbone of the correctness story |
| DB access | `pg` with hand-written SQL | The important query is a data-modifying CTE an ORM would obscure — see [D13](DECISIONS.md) |
| Market data | Coinbase Exchange public API | Real BTC/USD with a provider timestamp and trade id — see [D2](DECISIONS.md) |
| Tests | Vitest, against a real PostgreSQL | The guarantees are database behaviour — see [D15](DECISIONS.md) |
| Hosting | Long-running container (Railway / Render) | The settlement scheduler needs a process that stays alive — see [D3](DECISIONS.md) |
| Client bundle | 105 kB first load | No UI framework, no chart library |

### Why not AWS

AWS is listed as preferred, not required, and the honest answer is that nothing
here needs AWS to be correct. The requirements land on a relational database, a
long-lived HTTP process and an outbound call to a market data API — all of which a
container host with managed Postgres provides in two commands. Reaching for App
Runner + RDS + an EventBridge schedule would add IAM roles, a VPC, a container
registry and a scheduled trigger, and would consume most of a half-day exercise
without making any game rule more reliable.

The architecture does not preclude AWS: the app is a standard container with a
`DATABASE_URL`, and `POST /api/settle` exists so an EventBridge/CloudWatch
schedule can drive settlement without the in-process scheduler. That path is
documented as a deployment option rather than built and left unverified.

---

## Architecture

```mermaid
flowchart TB
  subgraph browser["Browser"]
    UI["React UI<br/>price · score · UP/DOWN<br/>countdown is presentational"]
  end

  subgraph server["Next.js server process (long-running container)"]
    API["Route handlers<br/>/api/state · /api/predictions · /api/settle"]
    SVC["Game service<br/>ownership boundary:<br/>who may do what"]
    RULES["Domain rules (pure)<br/>decideSettlement · compareDecimal"]
    SCHED["Settlement scheduler<br/>setInterval ≈5s"]
    SWEEP["Sweep runner<br/>one quote per sweep"]
    IDENT["Identity<br/>HMAC-signed cookie"]
  end

  subgraph data["Data"]
    DB[("PostgreSQL<br/>players · predictions<br/>partial unique index + CHECKs")]
  end

  COINBASE["Coinbase Exchange<br/>/products/BTC-USD/ticker"]

  UI -->|"HTTP (cookie only, never an id)"| API
  API --> IDENT
  API --> SVC
  SVC --> RULES
  SVC -->|"entry price"| COINBASE
  SVC --> DB
  SCHED --> SWEEP
  SWEEP --> RULES
  SWEEP -->|"one quote per sweep"| COINBASE
  SWEEP --> DB
  DB -.->|"due pending rows<br/>database clock"| SWEEP
```

**Who is responsible for what**

- **Browser.** Presentation only. It renders price, score, countdown and result,
  and it *asks* for state. It never decides an outcome, never computes a score,
  and never names a player. The countdown makes the wait visible; it has no
  authority (its clock may be wrong, and it may not even be open when
  settlement happens).
- **Route handlers.** Translate HTTP to domain calls and back: verify the
  identity cookie, validate input shape, map domain errors to status codes. No
  business rules live here.
- **Game service.** The ownership boundary. Fetches the entry quote, refuses an
  unusable one, and calls the store. This is where "who may do what" is decided.
- **Domain rules.** Pure functions with no database, no clock and no network.
  `decideSettlement` takes an entry price, a candidate quote and a `now`, and
  returns either a concrete outcome or a named reason to stay pending.
- **Settlement scheduler.** A `setInterval` in the server process that calls the
  sweep. Stateless, and it also runs once on boot, so restarts recover.
- **Database.** Holds the state of record *and* enforces invariants
  independently of the application (one pending prediction per player, no early
  resolution, outcome must match price movement).
- **Market data.** The only source of prices, used for both entry and
  settlement, so the comparison is meaningful.

Data flow for one round:

1. `POST /api/predictions` → identity verified → service asks the provider for a
   quote → quote freshness checked → row inserted (or `409` if one is already
   open) → authoritative state returned.
2. The scheduler ticks → the sweep asks the database which pending predictions
   are due (database clock) → one quote is fetched for the whole batch → each
   candidate is decided → settled rows are updated and the score moves in the
   same statement.
3. The UI polls `/api/state` and renders whatever the server says.

---

## Game rules

| Rule | Implementation |
| --- | --- |
| New players start at 0 | `players.score DEFAULT 0`, row created on first request |
| Points: correct +1, incorrect −1 | `case when outcome = 'win' then 1 else -1 end` in the settlement statement |
| One active prediction per player | Partial unique index; `409` on violation |
| Minimum 60 seconds | Checked against the database clock; also a `CHECK` constraint |
| The price must have changed | Strict decimal comparison against the recorded entry price |
| Unchanged price is not a result | Returns `pending` with reason `price_unchanged` |
| Server owns the outcome | Direction is the only thing the client sends |

## Settlement policy

Stated precisely, because "fair" is not a specification:

**Entry.** A prediction is created only if a quote is available whose provider
timestamp is no older than 15 seconds and no more than 5 seconds ahead of the
server's clock. The raw price string, the quote's timestamp and its trade id are
stored, along with the creation time from the database clock. If no usable quote
exists, **no prediction is created** (`503`).

**Eligibility.** A prediction becomes eligible at `created_at + 60 seconds`, both
measured by the database. Nothing resolves before that, regardless of what any
client clock says.

**The settlement quote** is the provider's current quote at the first sweep where
the prediction is eligible, subject to:

| Check | Rule if it fails |
| --- | --- |
| Quote exists | `pending: provider_unavailable` |
| Quote is not from the future (>5s ahead) | `pending: quote_from_future` |
| Quote is not stale (≤30s old) | `pending: stale_quote` |
| Quote is strictly newer than the entry quote (timestamp, and trade id when both are present) | `pending: quote_not_after_entry` |
| Quote price differs from the entry price | `pending: price_unchanged` |

**Scoring.** `settlement_price > entry_price` is a win for UP and a loss for DOWN;
`settlement_price < entry_price` is the reverse. Comparison is exact decimal, not
floating point.

**Idempotency.** Settlement is one statement that only updates rows still in
`pending`, and the score change is driven by the rows that statement actually
returned. A second attempt — whether a retry, a race, or a duplicated cron call —
matches nothing and changes no score.

**Failure bias.** Every ambiguous case resolves to `pending`, never to a guess. A
prediction that stays open is visible; a wrong score is not.

---

## Data model

```
players
  id            uuid        primary key (server-generated)
  score         integer     not null default 0
  created_at    timestamptz not null default now()
  last_seen_at  timestamptz not null default now()

predictions
  id                  uuid        primary key
  player_id           uuid        not null → players(id) on delete cascade
  direction           text        not null check in ('up','down')
  entry_price         numeric(18,8) not null check (entry_price > 0)
  entry_price_at      timestamptz not null          -- provider timestamp
  entry_trade_id      bigint                        -- provider sequence, when available
  price_source        text        not null          -- which provider produced the entry quote
  created_at          timestamptz not null default now()   -- server/database clock
  status              text        not null default 'pending' check in ('pending','resolved')
  settlement_price    numeric(18,8)
  settlement_price_at timestamptz
  resolved_at         timestamptz
  outcome             text        check in ('win','loss')
```

### Which invariants are enforced where

| Invariant | Enforced by | Notes |
| --- | --- | --- |
| One pending prediction per player | **Database** (partial unique index) | The application also pre-checks, for a friendly error |
| Valid direction / status / outcome values | **Database** (`CHECK`) | |
| Resolved rows have complete settlement data; pending rows have none | **Database** (`CHECK`) | Prevents half-settled rows |
| No resolution before 60 seconds | **Database** (`CHECK`) *and* application | Deliberately duplicated |
| Settlement quote strictly later than entry quote | **Database** (`CHECK`) *and* application | |
| Outcome matches the price movement | **Database** (`CHECK`) *and* application | Includes "unchanged is not a result" |
| Score moves exactly once per prediction | **Database** (conditional `UPDATE` + same-statement score change) | |
| Entry price is honest and fresh | **Application** (cannot be expressed in SQL — depends on an external call) | |
| A prediction is not created while one is open | **Application** pre-check + **database** index | The index is the real guarantee |

Rationale for the duplication is in [DECISIONS.md D7](DECISIONS.md): rules exist
in both places on purpose, and the test suite covers the pair.

---

## Local setup

Requirements: **Node.js ≥ 20.11** and a **PostgreSQL ≥ 13** instance
(`gen_random_uuid()` must be built in).

```bash
git clone https://github.com/hitchcock9000/bitcoin-prediction-game.git
cd bitcoin-prediction-game
npm install

cp .env.example .env
# edit .env: DATABASE_URL and a PLAYER_COOKIE_SECRET of >= 32 chars
#   openssl rand -base64 48

createdb bpg_dev          # or use any managed Postgres
npm run db:migrate
npm run dev
```

The app is then on <http://localhost:3000>.

No PostgreSQL locally? Docker is enough:

```bash
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bpg_dev postgres:17
```

### Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `PLAYER_COOKIE_SECRET` | yes | — | HMAC key for the player cookie (≥32 chars). Changing it invalidates existing player cookies |
| `DATABASE_SSL` | no | `false` | Set `true` for providers that require TLS |
| `COOKIE_SECURE` | no | `true` in production | `false` only when serving over plain HTTP |
| `PRICE_PROVIDER` | no | `coinbase` | `coinbase` or `simulated` (simulated is refused in production unless explicitly allowed) |
| `ALLOW_SIMULATED_PRICES` | no | `false` | Deliberate opt-in required to run simulated prices in production |
| `COINBASE_API_BASE` | no | `https://api.exchange.coinbase.com` | Override for testing/mocking |
| `PRICE_FETCH_TIMEOUT_MS` | no | `4000` | Provider request timeout |
| `SETTLEMENT_SCHEDULER_ENABLED` | no | `true` | Set `false` on all but one instance when scaling out |
| `SETTLEMENT_INTERVAL_MS` | no | `5000` | Sweep interval |
| `SETTLEMENT_SECRET` | no | unset | When set, enables `POST /api/settle` for an external cron |
| `TEST_DATABASE_URL` | no | local sandbox default | Database used by integration tests |

Secrets are read from the environment only. Nothing in `src/` reaches the
database or the price API from the browser: there is no `NEXT_PUBLIC_` variable
in this project, by design.

### Database setup and migrations

Migrations are numbered SQL files in `migrations/`, applied in filename order,
each in its own transaction, recorded in a `schema_migrations` table:

```bash
npm run db:migrate          # applies anything not yet applied; safe to re-run
```

The runner is `scripts/migrate.mjs` — plain JavaScript so that the CLI, the
integration tests and the production container all use the *same* implementation.
Schema changes are made by adding a new file; existing migrations are never
edited after they have been applied anywhere.

### Running the application

```bash
npm run dev        # development server with hot reload
npm run build      # production build (standalone output for containers)
npm start          # run the production build
```

### Running tests

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest: unit + integration
npm run test:unit   # no database required
```

### What has been run, and what it reported

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, 0 warnings |
| `npm test` | **160 tests passing** across 10 files |
| `npm run build` | production build succeeds (105 kB first load) |
| `node scripts/smoke.mjs --expect-simulated` | **14/14 checks** (full journey over HTTP) |

Test layout:

| File | What it covers |
| --- | --- |
| `tests/unit/rules.test.ts` | The settlement policy: all four win/loss combinations, the exact 60s boundary, unchanged price, stale/future quotes, provider failure, quote ordering |
| `tests/unit/decimal.test.ts` | Exact decimal comparison, including cases a float would get wrong |
| `tests/unit/coinbase.test.ts` | Response parsing against a **captured live payload**, plus every rejection case |
| `tests/unit/identity.test.ts` | Cookie signing, tampering, expiry, `Set-Cookie` attributes |
| `tests/unit/config.test.ts` | Configuration guard rails, including simulated prices in production |
| `tests/unit/cachedProvider.test.ts` | Display-price cache TTL and stale-on-error bounds |
| `tests/unit/view.test.ts` | Response mapping, price normalisation, countdown arithmetic |
| `tests/integration/store.test.ts` | Database invariants: 20 concurrent creations, 10 concurrent settlements, each `CHECK` constraint |
| `tests/integration/game-loop.test.ts` | Create → settle over the real store, restart recovery, returning players, racing sweeps |
| `tests/integration/http.test.ts` | HTTP semantics: cookies, forgery, 409/503/400/401 handling, state recovery |

### End-to-end verification against a running server

```bash
npm run build && npm run standalone:prepare
node --env-file=.env .next/standalone/server.js &
node scripts/smoke.mjs --expect-simulated
```

The smoke script drives the entire journey over real HTTP and takes ~70 seconds,
because the 60-second rule is real. It is deliberately not part of the unit suite
for that reason.

**Restart recovery, as demonstrated:** create a prediction → kill the server
before its window elapses → wait past the deadline with the process down → confirm
the row is still `pending` in the database → restart. The boot sweep settles it
immediately, the score moves exactly once, and the same cookie can play again.
Nothing lives in process memory.

Integration tests need a real PostgreSQL. A local one, or Docker:

```bash
docker run --rm -p 55432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bpg_test postgres:17
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/bpg_test npm test
```

The test database is migrated automatically by the suite. There is deliberately
no "skip if no database" escape hatch: if the database is missing, the suite
fails loudly rather than reporting green while the guarantees went unverified.

```bash
npm run ci          # typecheck + lint + tests + production build
```

---

## Deployment

### Selected zero-cost deployment: Vercel Hobby + Neon Free

1. Keep the Vercel scope on Hobby and create Neon on Free (no paid add-ons or
   trial upgrades). Select Frankfurt for both. Neon usage must remain within
   its free quota; a public demo is not an unlimited-capacity service.
2. Store Neon's pooled TLS URL as `DATABASE_URL` in `.env.local` and its direct
   URL as `DATABASE_MIGRATION_URL`. Neither is committed. Run `npm run db:migrate`;
   the migration CLI prefers the direct URL. Never run migrations on requests.
3. Set Vercel production environment variables: `DATABASE_URL`, a generated
   `PLAYER_COOKIE_SECRET`, a separate generated `SETTLEMENT_SECRET`,
   `PRICE_PROVIDER=coinbase`, `SETTLEMENT_SCHEDULER_ENABLED=false`,
   `DATABASE_POOL_MAX=2`. Keep secure cookies enabled. Use Neon's TLS URL and
   do not disable certificate validation. Do not expose these as NEXT_PUBLIC.
4. Deploy `main` using the Next.js preset. `vercel.json` specifies Frankfurt
   and bounded 30-second API requests; it deliberately has no Vercel cron.
5. In cron-job.org Free, create one job every 15 minutes, HTTP POST to the
   production `/api/settle`, with custom header `x-settlement-secret` matching
   `SETTLEMENT_SECRET`. Keep that secret out of the URL. Enable failure email
   notifications. Verify successful execution history; merely configuring the
   header does not prove the job ran. The production URL must be publicly
   accessible without Vercel login protection.
6. Verify live Coinbase, score persistence, the real 60-second game flow, and
   a closed-browser round resolved by an actual scheduled execution. Health
   should show `schedulerEnabled=false`, `schedulerRunning=false`,
   `requestTriggered=true`, and `externalTriggerConfigured=true`.

State polling is the normal experience and awaits the shared settlement sweep.
Cron is only the idle fallback. Both may race safely through atomic settlement.
If no player visits, resolution can be delayed by roughly 15 minutes, plus
provider outages or unchanged prices. Later pricing can change the outcome.
The chosen cadence lets Neon suspend between idle jobs, unlike a permanent
minute-level cron. Monitor free compute usage; do not upgrade automatically.

The container instructions below are retained as an alternative only.

**Not yet deployed, so no public URL is claimed here.** Everything needed is in
the repository and the steps below have been exercised locally in production
mode; only the account-specific part remains.

### Target shape

A **long-running container** plus **managed PostgreSQL**. The container must
stay alive between requests, because the settlement scheduler lives in the
process ([D3](DECISIONS.md)).

```mermaid
flowchart LR
  U[Browser] -->|HTTPS| H["Container host<br/>node server.js<br/>(web + scheduler)"]
  H -->|DATABASE_URL| PG[("Managed PostgreSQL")]
  H -->|entry + settlement quotes| CB[Coinbase Exchange]
  CRON["optional external cron<br/>POST /api/settle"] -.->|SETTLEMENT_SECRET| H
```

### Files

- `Dockerfile` — multi-stage build running the standalone bundle as a non-root
  user, with a `HEALTHCHECK` against `/api/health`. *(The command it runs was
  verified locally; `docker build` itself was not, because no Docker daemon was
  available in the development environment.)*
- `railway.json` / any equivalent — not committed, because the configuration is
  provider form fields rather than code.

### Steps (Railway or Render; both are equivalent)

1. Create a PostgreSQL instance and copy its connection string.
2. Create a service from this repository. It detects the `Dockerfile`.
3. Set environment variables (secrets, not committed):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | from step 1 (add `DATABASE_SSL=true` if required) |
   | `PLAYER_COOKIE_SECRET` | `openssl rand -base64 48` |
   | `PRICE_PROVIDER` | `coinbase` (the default; do not set `simulated`) |
   | `SETTLEMENT_SECRET` | optional, enables the external settle endpoint |

4. Run migrations once per deployment, before starting the app:

   ```bash
   node scripts/migrate.mjs        # inside the container, or from a release shell
   ```

5. Deploy, then verify (below).

### Post-deployment verification checklist

Run these against the public URL and read the output — not the dashboard.

```bash
# 1. Health: database up, provider named, scheduler running in this process
curl -s https://<host>/api/health | jq .

# 2. Full journey over HTTP: cookie, entry, duplicate rejection, settlement, score
node scripts/smoke.mjs --base-url https://<host>

# 3. Confirm it is NOT serving simulated prices
curl -s https://<host>/api/health | jq '.priceProvider'
#    expect: { "name": "coinbase-exchange:BTC-USD", "simulated": false }

# 4. In a browser: place a prediction, close the tab, reopen after a minute.
#    The score must have changed with no page open in between.

# 5. Restart the service mid-round and confirm the prediction still settles.
```

If step 2 or 3 fails, the deployment is not working regardless of what the
dashboard shows.

### Reliability notes for the operator

- Keep **one instance**. Multiple instances are safe (settlement is idempotent,
  [D4](DECISIONS.md)) but each one polls the price feed; disable the scheduler on
  the others with `SETTLEMENT_SCHEDULER_ENABLED=false`.
- On a host that suspends idle containers (free tiers), predictions settle late
  while suspended. Schedule a cron hitting `POST /api/settle` with
  `x-settlement-secret` to bound that, or run a paid always-on instance.
- `GET /api/health` exposes pending count and oldest pending age — useful for
  spotting a stuck market or a stalled scheduler.

---

## Trade-offs and limitations

Honest list; the reasoning is in [DECISIONS.md](DECISIONS.md).

- **Settlement is timer-based inside the web process.** On a host that suspends
  idle containers, ticks are delayed until it wakes. Predictions then settle
  late — never wrongly, because eligibility is computed from the stored
  `created_at`. A serverless deployment would rely on an external cron hitting
  `/api/settle` at minute granularity, i.e. late by design.
- **Multiple instances are safe but wasteful.** N schedulers would each poll the
  provider; `SETTLEMENT_SCHEDULER_ENABLED=false` exists for that reason.
- **A prediction can stay open indefinitely** if the price never moves between
  the entry quote and successive sweeps (see A1).
- **Identity is integrity, not authentication.** Clearing the cookie means a new
  player at zero; nothing prevents creating several identities. Scores are
  therefore not trustworthy as a competitive ranking — see [D9](DECISIONS.md).
- **No rate limiting** on `POST /api/predictions`. The unique index bounds the
  damage (a player cannot accumulate predictions) and request bodies are capped
  at 1 KB ([D22](DECISIONS.md)), but request *volume* is unbounded — a per-IP or
  per-player limiter is the next step.
- **Single venue price.** One exchange, not a cross-venue index.
- **Score integrity is not enforced across tables.** `players.score` is derived
  from resolved predictions, but no constraint verifies the sum (a `CHECK`
  cannot span tables). A reconciliation query is documented rather than a
  trigger implemented.
- **No leaderboard or history UI.** Not requested.
- **UI interactions were not driven by a real browser engine** in the development
  environment (none available). The UI is verified by serving the production
  build, checking the rendered HTML and static assets, and exercising every
  endpoint it calls over HTTP — including the whole loop with cookies. Focus
  handling and hydration warnings have not been observed directly; a jsdom or
  Playwright component test is the next step.
- **The Docker image was not built.** The command the image runs
  (`node .next/standalone/server.js`) was verified directly, but no Docker daemon
  was available to run `docker build`.

## Next improvements

In rough priority order, with what would trigger each:

1. **Chunked sweeps and a dedicated worker** if pending volume grows enough that
   one tick cannot clear the due batch.
2. **Rate limiting** per player and per IP on prediction creation.
3. **A reconciliation job** asserting `players.score = count(wins) − count(losses)`
   per player.
4. **Metric emission** (settlement latency, provider error rate, pending count)
   for real operational visibility instead of log lines.
5. **Careful handling of a stuck market**: a documented maximum wait, or a
   product decision about what happens if the price never moves.
