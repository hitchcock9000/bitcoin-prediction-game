# Engineering decisions

This is the reasoning trail behind the implementation. It records the problem
each decision addresses, the alternatives considered, what the code does now and
the trade-off that remains. The entries are ordered by decision number; D23
supersedes the original hosting choice in D3.

## D1 — Let PostgreSQL enforce one pending prediction per player

A service-level “check, then insert” looks sufficient until two requests arrive
together. Both can observe no pending row and both can insert.

The schema uses a partial unique index on `player_id` where `status = 'pending'`.
The service still checks first because it avoids an unnecessary Coinbase call
and gives a clearer response, but the index is the concurrency guarantee. The
store translates that specific `23505` violation into a `409` response.

The integration suite sends 20 concurrent creation attempts and expects exactly
one success. This keeps the important claim tied to real PostgreSQL behaviour.

## D2 — Use Coinbase Exchange for BTC/USD quotes

The game needs more than a price. It needs a timestamp belonging to the quote so
entry and settlement can be ordered without pretending the HTTP response time is
the market time.

The provider comparison ruled out Coinbase's simpler spot endpoint and Kraken's
ticker because neither response included a usable provider timestamp. Binance
offered BTC/USDT rather than BTC/USD and returned a region-dependent availability
error during the recorded check. Coinbase Exchange's
`/products/BTC-USD/ticker` supplies a BTC/USD price, `time` and `trade_id`
without requiring an API key.

This still uses one venue, not a cross-exchange reference price. That is enough
for the assignment but would need a product decision in a wider release.

## D3 — Keep settlement stateless; choose the trigger per host

The first deployment plan used a long-running container and an in-process
five-second timer. The useful part of that design was not the timer itself: it
was the stateless sweep that rediscovers pending work from PostgreSQL after a
restart.

The container scheduler remains available for local or container hosting. The
public Vercel deployment disables it because a serverless function cannot own a
dependable interval. D23 describes the request and cron triggers used instead.

Per-prediction timers were rejected because they disappear on restart and leave
no durable record of the work they were meant to perform.

## D4 — Resolve the prediction and change the score in one statement

Settlement is a data-modifying CTE in `src/server/game/store.ts`. The first CTE
updates the prediction only while it is still `pending`; the second changes the
score only from the row returned by the first.

That shape closes the gap between “mark resolved” and “change score.” A duplicate
or racing call updates zero rows and becomes a normal no-op. Tests cover repeated
settlement, 10 concurrent attempts, racing sweeps and overlap between a state
request and the authenticated cron endpoint.

A multi-statement transaction with explicit row locking could also work, but the
single statement makes the dependency between the two updates harder to break.

## D5 — Use the database clock for the 60-second rule

PostgreSQL writes `created_at`, selects due rows with `now()` and enforces the
minimum wait in a `CHECK` constraint. The sweep returns the same database time to
the pure decision function.

Using an application clock for one of those steps would introduce avoidable
clock-drift disagreements between Vercel and Neon. The browser countdown is only
presentation and has no authority.

## D6 — Keep prices as exact decimal strings

Coinbase sends the price as a string. The provider keeps that string intact,
PostgreSQL stores it as `NUMERIC(18,8)`, and the domain compares normalised
decimal strings with `compareDecimal`.

Converting to JavaScript `number` would introduce binary floating-point into the
decision that awards points. Formatting for display happens separately.

## D7 — Repeat critical rules as database constraints

The TypeScript policy gives useful pending reasons and is easy to test. The
database constraints protect stored state even if a future caller bypasses part
of the service layer.

The schema checks that resolved rows are complete, resolution is at least 60
seconds after creation, the settlement quote follows the entry quote, the price
changed, and the outcome matches direction and movement.

Constraint testing found a real mistake in the first outcome expression: an
unchanged price could have been stored as a loss. The final constraint includes
`settlement_price <> entry_price`, and the integration suite tries to insert
contradictory rows directly.

## D8 — Leave uncertain rounds pending

Entry is refused when there is no usable quote. During settlement, an unavailable,
stale, future-dated, replayed or unchanged quote leaves the prediction pending.

The alternative was to reuse a displayed or cached value, or convert equality
into a loss. Both would create a result the server could not defend. A delayed
round is visible and can be retried; an invented score is much harder to detect.

The flat-market consequence is explicit: a prediction can stay open
indefinitely until a later eligible quote moves.

## D9 — Use a signed anonymous cookie for player identity

The server creates a random UUID and signs the player ID and issue time with
HMAC-SHA256. The cookie is `HttpOnly`, and production cookies are `Secure`.
Malformed, expired, future-dated or incorrectly signed tokens are ignored.

This prevents a browser from choosing another known player ID. It is not
authentication: clearing the cookie creates a new player, and scores are not a
competitive identity system. Accounts were outside the assignment scope.

## D10 — Make simulated prices visibly development-only

The simulated provider makes local and controlled testing possible. It has a
different source name, the UI displays a demo banner, and production rejects
`PRICE_PROVIDER=simulated` unless `ALLOW_SIMULATED_PRICES=true` is set
explicitly.

The public deployment uses Coinbase and reports `simulated: false` through the
health endpoint.

## D11 — Share one quote across a settlement sweep

A sweep fetches one current quote and applies that observation to every due row
in its bounded batch. Fetching once per prediction would let players due in the
same sweep be compared against different moments and would multiply provider
traffic.

This choice makes the batch coherent, but trigger cadence and backlog still
affect when that observation occurs. The public deployment does not promise a
price captured at exactly second 60.

## D12 — Require settlement data to be later than entry data

A later HTTP request does not prove a later market quote. The settlement policy
requires the provider timestamp to be strictly later than the entry timestamp.
When both quotes include trade IDs, the settlement trade ID must also be larger.

Freshness limits make part of the timestamp guard defensive under today's
constants, but keeping the ordering rule explicit protects future changes and
catches replayed provider data.

## D13 — Keep handwritten SQL in one module

All game SQL lives in `src/server/game/store.ts`. The service and rule layers use
typed objects and do not know query details.

An ORM would reduce some row-mapping work, but it would obscure the most
important query: the conditional settlement CTE. For this project, a small SQL
surface is easier to inspect than an additional abstraction.

## D14 — Store the score and keep predictions as its audit trail

`players.score` makes the main state read cheap. Resolved prediction rows still
contain enough information to recompute `count(wins) - count(losses)`.

PostgreSQL cannot express that cross-table equality as a simple `CHECK`. A
larger system should run reconciliation and alert on a mismatch. A trigger was
not added because the existing settlement statement already owns both updates.

## D15 — Test database behaviour against real PostgreSQL

Unit tests cover pure rules, decimal handling, identity and provider parsing.
Integration tests use PostgreSQL because mocks cannot prove partial indexes,
constraints, row contention or the data-modifying CTE.

The final deployment pass recorded 170 passing tests across 10 files. The suite
fails when its test database is unavailable rather than quietly skipping the
checks that matter most.

## D16 — Keep route handlers as plain Request/Response functions

The files under `src/app/api/**/route.ts` only delegate to handlers created in
`src/server/http/handlers.ts`. Those handlers accept a standard `Request` and
return a standard `Response`.

This keeps Next.js details at the edge and lets HTTP tests cover cookies, status
codes, headers and JSON without booting the framework. Business rules remain in
the domain and service layers.

## D17 — Cache display prices, not authoritative prices

The price shown in the UI uses a short two-second cache to reduce repeated
Coinbase calls during polling. Prediction entry and settlement always use the
uncached provider.

That separation matters because the displayed price is informational. Reusing
it for scoring would quietly promote a UI optimisation into game authority.

## D18 — Keep SameSite configurable

`SameSite=Lax` is the default for a normal top-level deployment. Some preview or
embedded environments treat that cookie as third-party, so `COOKIE_SAME_SITE`
can be changed to `None`; production then requires `Secure`.

The option exists for deployment compatibility, not because the current public
game needs cross-site cookies.

## D19 — Verify the artifact that is actually run

The container path uses Next.js standalone output. `scripts/prepare-standalone.mjs`
copies the required static files, public assets and migration files into the
standalone directory before `node .next/standalone/server.js` starts.

The standalone server command and HTTP smoke journey were verified locally. A
Docker image build was not recorded because no Docker daemon was available in
that environment. The public deployment now uses Vercel rather than this
container path.

## D20 — Clamp the countdown to the server-owned deadline

The HTTP smoke test exposed `secondsRemaining: 61` immediately after creation.
The handler's time was captured just before PostgreSQL assigned `created_at`, so
the database timestamp could be slightly later.

The view now clamps the countdown to the configured 60-second maximum. This is a
display fix only; eligibility continues to use database time.

## D21 — Keep the browser contract in a types-only module

`src/shared/api.ts` contains the response shapes used by both the UI and server.
It has no runtime imports, secrets, providers or database code.

This lets TypeScript check the contract without making it easy to pull server
modules into the client bundle. The production client chunks were also checked
for database URLs, cookie names and settlement secrets, with no matches.

## D22 — Bound prediction request bodies

An adversarial HTTP check found that a 2 MB JSON body was accepted even though a
valid request is about 20 bytes. Next.js route handlers did not impose the
expected default limit.

The handler now rejects a declared body over 1 KB before reading it and also
checks the actual string length for requests without `Content-Length`. The second
check limits parsing and processing, not proxy-level buffering; a hard streaming
limit belongs at the hosting edge.

The recorded retest returned `413 payload_too_large` for 2 MB and still accepted
a normal request.

## D23 — Deploy on free serverless hosting

The goal was a public take-home project with real Coinbase prices and no hosting
cost. The selected setup is Vercel Hobby, Neon Free and cron-job.org Free.

On Vercel, `GET /api/state` awaits a bounded settlement sweep before returning
state. This gives an active player a result soon after the minimum wait. A
secret-protected `POST /api/settle` runs every 15 minutes as the idle fallback.
The in-process scheduler is forced off when `VERCEL=1`. Both triggers call
`runSettlementSweep`, and D4 makes overlap safe.

The trade-off is timing: an idle round can use a much later quote, and that can
change the outcome. The game guarantees “not before 60 seconds,” not “the market
price at exactly 60 seconds.” A permanent worker or historical market feed would
support tighter semantics, but would add cost or infrastructure beyond this
exercise.

The deployment was checked on 16 October 2026:

- Vercel reported Hobby and Neon reported Free;
- migrations applied successfully and health reported the database up;
- Coinbase reported `simulated: false`;
- a request-triggered production round settled after the threshold and repeated
  reads left its score unchanged;
- a separate prediction received no state request after creation, then a cron
  POST returned 200 at `10:45:16.680Z` and PostgreSQL resolved it at
  `10:45:17.129Z` using a quote timestamped `10:45:16.226Z`;
- the local verification pass completed typecheck, lint, the production build
  and all 170 tests.

## D24 — Coalesce overlapping sweeps inside one server instance

Review entry: 16 October 2026.

The database already makes concurrent settlement safe, but correctness did not
make duplicate work free. Before this review, a state poll and cron request that
overlapped in the same warm Vercel instance each selected candidates and each
called Coinbase. At higher traffic that amplifies provider requests and creates
avoidable database contention.

`createHandlers` now keeps one in-flight sweep promise and lets overlapping
requests await it. This is deliberately process-local: it reduces duplicate
work without adding a lock service or holding a database transaction open
across a network call. Separate Vercel instances may still race, so the atomic
settlement statement remains the correctness boundary.

The HTTP integration tests cover both cases. One handler graph makes one
provider call for overlapping state and cron requests; two independent handler
graphs still race and change the score exactly once.

## D25 — Treat anonymous identity failures as recoverable input

Review entry: 16 October 2026.

The player cookie is untrusted input. A percent-encoded value that could not be
decoded previously threw before signature verification and turned a normal
state request into a 500. `readCookie` now treats that value as absent, which
uses the existing safe behaviour: issue a new signed identity.

A related edge case appeared when a first-time player submitted a valid
direction while Coinbase was unavailable. The service had already created the
player row, but the `503` response did not include the newly minted cookie. A
retry therefore created another anonymous player. Error responses after
identity resolution now preserve that cookie. The round still is not created
without a trustworthy price.

## D26 — Poll according to what the player can observe

Review entry: 16 October 2026.

Polling every three seconds is useful while a round is approaching settlement,
but it was also running for idle players and hidden tabs. Ten thousand idle
tabs would produce roughly 3,333 state requests per second before doing useful
work.

Active rounds still poll every three seconds. Idle screens poll every ten
seconds, hidden tabs make no polling request, and returning to the tab triggers
an immediate refresh. This does not solve large-scale rate limiting, but it
removes obvious background traffic without changing the API or the active game
experience.

## D27 — Recover explicitly from concurrent insert conflicts

Review follow-up: 16 October 2026.

The partial unique index already prevented two pending predictions, but the
losing request surfaced the store's `ActivePredictionExistsError` as HTTP 500.
The service now reloads the winning row and translates that known conflict to
the existing `PredictionAlreadyActiveError`, so the HTTP layer returns 409 with
authoritative state. A barrier-controlled HTTP test forces both requests past
the pre-check before either insert runs.

Player creation had a subtler PostgreSQL edge case. The single-statement
`INSERT ... ON CONFLICT DO NOTHING` CTE can observe another transaction's
conflict while its original statement snapshot still cannot see the row that
caused it. If the CTE returns no row, `ensurePlayer` now performs one separate
`SELECT`, which gets a fresh Read Committed snapshot. I rejected `ON CONFLICT DO
UPDATE ... RETURNING`: it would return the row in one statement, but would also
turn every polling read for an existing player into an unnecessary write.

The regression test holds the first insert open, confirms through
`pg_blocking_pids` that the second connection is waiting for it, commits the
first transaction and verifies that the fallback returns the player. This
covers the actual transaction ordering rather than hoping concurrent promises
happen to reproduce it.

## Open questions

These need product or scale evidence before code changes:

- Should a flat market eventually become a draw or no-result outcome?
- Does the product want the first observed quote after 60 seconds, or a
  historical price tied to the exact deadline?
- At what traffic level does settlement move to a dedicated worker?
- When do anonymous scores need real accounts?
- What rate limits are appropriate for prediction creation?
- Should a reconciliation job compare stored scores with resolved predictions?
