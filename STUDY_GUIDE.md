# Bitcoin prediction game — study guide

This file is for interview preparation. It is intentionally separate from the
public README.

## The five decisions to understand first

### 1. The server owns every authoritative value

The browser sends only `{ "direction": "up" }` or `{ "direction": "down" }`.
The server gets the player from a signed cookie, fetches the Coinbase price and
uses database timestamps. React renders the answer; it does not calculate one.

Natural explanation:

> I wanted one obvious trust boundary. The browser can express intent, but it
> cannot name a player, choose a price, move a clock or add points. That removes
> several classes of validation bugs instead of trying to catch each one later.

### 2. Concurrency rules live in PostgreSQL

The partial unique index on pending predictions is the real guarantee that a
player cannot open two rounds. The service checks first for a better error, but
two requests can pass that check at the same time. The index still allows only
one insert.

Natural explanation:

> An application pre-check is useful for UX, but it is not a concurrency
> guarantee. I put the invariant at the point where competing requests meet:
> the database.

### 3. Prediction settlement and score changes are atomic and idempotent

`settlePrediction` uses one data-modifying CTE statement. It changes a row only
while its status is `pending`, then updates the player's score from the row that
was actually changed. A competing settlement finds nothing to update and cannot
change the score.

Natural explanation:

> I did not want a gap between “mark this resolved” and “add a point.” One SQL
> statement makes them commit together, and the pending condition turns retries
> and races into harmless no-ops.

### 4. Unknown or unusable market data means “keep waiting”

The settlement rule checks the 60-second floor, provider availability, quote
freshness, future clock skew, ordering after the entry quote and actual price
movement. Every ambiguous case returns a named pending reason.

Natural explanation:

> A delayed result is visible and recoverable. A fabricated result is silent
> corruption. When I cannot defend the quote, I leave the round pending.

### 5. The zero-cost deployment uses two triggers for the same sweep

Active players trigger a sweep through `GET /api/state`. A protected external
cron triggers the same function every 15 minutes when there is no traffic. The
in-process timer is disabled on Vercel but remains available for a container.

Natural explanation:

> Vercel Hobby does not give me a permanent worker. I kept the settlement logic
> stateless, then used requests for the normal experience and a free cron as the
> idle fallback. The database already makes overlapping calls safe.

## A useful mental model

```text
React UI
  -> Next.js route
  -> HTTP handler
  -> game service / settlement sweep
  -> pure domain rule
  -> PostgreSQL

Coinbase -> server only
Cookie secret -> server only
Cron secret -> server only
```

The key separation is:

- routes translate framework calls;
- handlers own HTTP and identity;
- the game service coordinates entry;
- pure functions decide whether settlement is allowed;
- the store is the only SQL boundary;
- PostgreSQL is the final guard for concurrency and persisted invariants.

## Relevant code paths

| Path | Why it matters |
| --- | --- |
| `src/app/Game.tsx` | React state, polling, submission and explicit UI states |
| `src/app/api/**/route.ts` | Thin Next.js wrappers around the HTTP handlers |
| `src/server/http/runtime.ts` | Wires real database, providers, handlers and configuration |
| `src/server/http/handlers.ts` | Identity, request validation, response mapping and settlement triggers |
| `src/server/identity.ts` | Anonymous UUID cookie creation and HMAC verification |
| `src/server/game/service.ts` | Entry flow: player, pre-check, live quote validation and persistence |
| `src/server/game/store.ts` | All SQL, including the atomic settlement query |
| `src/domain/rules.ts` | Pure entry and settlement policy |
| `src/domain/decimal.ts` | Exact decimal comparison without JavaScript floats |
| `src/server/prices/coinbase.ts` | Live ticker fetch, timeout and payload validation |
| `src/server/prices/cached.ts` | Short cache used only for display prices |
| `src/server/settlement/runner.ts` | Finds due rows, shares one quote and settles each candidate |
| `src/server/settlement/scheduler.ts` | Optional timer for local/container deployments |
| `src/instrumentation.ts` | Starts that timer outside Vercel |
| `migrations/001_init.sql` | Tables, constraints and indexes that encode the rules |
| `scripts/migrate.mjs` | Transactional migration runner |
| `tests/unit/` | Pure rules, provider parsing, identity and view mapping |
| `tests/integration/` | Real PostgreSQL, HTTP semantics and concurrency |

## Important functions

### React and HTTP

#### `Game.load` — `src/app/Game.tsx`

Calls `/api/state` every three seconds and replaces local state with the server
response. If a refresh fails, it keeps the previous state visible and shows a
recoverable error.

Why it works: the UI never tries to merge scores or derive a result. Each good
response is a fresh authoritative snapshot.

#### `Game.submit` — `src/app/Game.tsx`

Posts only the chosen direction. A `409` includes current server state, so two
tabs or a double action can resynchronise immediately.

Important detail: the countdown is presentational. It is seeded from the server
and ticks locally, but reaching zero does not settle anything.

#### `getHandlers` — `src/server/http/runtime.ts`

Builds the real object graph once per process: configuration, store, Coinbase
provider, display cache, game service and HTTP handlers.

The display provider may cache for two seconds. Entry and settlement use the
uncached live provider, so a UI optimisation cannot affect a score.

#### `createHandlers` — `src/server/http/handlers.ts`

Returns the four HTTP handlers:

- `handleState` resolves identity, awaits a settlement sweep, then reads state;
- `handleCreatePrediction` validates the small JSON body and submits a round;
- `handleSettle` checks the cron secret and runs the same sweep;
- `handleHealth` checks the database and exposes non-secret operational state.

`handleState` catches sweep failure and still returns stored game state. A
temporary Coinbase error should not stop someone seeing their score.

### Identity and entry

#### `createPlayerToken` — `src/server/identity.ts`

Creates a random UUID and signs `playerId.issuedAt` with HMAC-SHA256.

#### `verifyPlayerToken` — `src/server/identity.ts`

Rejects malformed, expired, future-dated or incorrectly signed tokens. Signature
comparison uses `timingSafeEqual`.

This provides integrity, not login. Clearing the cookie creates a new identity.

#### `createGameService` — `src/server/game/service.ts`

The important method is `submitPrediction`:

1. ensure the player exists;
2. pre-check for an active prediction;
3. fetch a live server-side quote;
4. validate its timing with `evaluateEntryQuote`;
5. insert the prediction;
6. return freshly read player state.

The pre-check saves an unnecessary Coinbase request and gives a clear response.
The database index remains the concurrency guarantee.

### Prices and rules

#### `createCoinbaseProvider` — `src/server/prices/coinbase.ts`

Fetches `/products/BTC-USD/ticker` with a four-second default timeout and no
HTTP cache. It wraps transport, status and JSON errors as `PriceProviderError`.

#### `parseCoinbaseTicker` — `src/server/prices/coinbase.ts`

Validates the payload and preserves the price as a string. It parses the
provider timestamp and keeps a safe integer trade ID when possible.

#### `compareDecimal` — `src/domain/decimal.ts`

Compares normalised integer and fractional string parts. It avoids converting
money-like values to binary floating point.

#### `evaluateEntryQuote` — `src/domain/rules.ts`

Rejects a quote more than 15 seconds old or more than five seconds in the
future. A bad entry quote means no prediction is created.

#### `decideSettlement` — `src/domain/rules.ts`

This is the central pure function. In order, it checks:

1. at least 60 seconds have elapsed;
2. a quote exists;
3. the quote is not too far in the future;
4. the quote is no more than 30 seconds old;
5. timestamp and trade ID place it after the entry quote;
6. the price has actually changed.

Only then does it return `kind: 'settle'` with a win or loss. Because the
function has no I/O and accepts its clock and quote, the tests can cover exact
boundaries without waiting in real time.

### Persistence and settlement

#### `createGameStore` — `src/server/game/store.ts`

This is the only module containing game SQL.

- `ensurePlayer` inserts once and otherwise returns the existing player;
- `getActivePrediction` and `getLatestPrediction` build the state view;
- `createPrediction` relies on the partial unique index and maps its specific
  violation to `ActivePredictionExistsError`;
- `listSweepable` selects due rows using the database clock;
- `settlePrediction` resolves the row and changes the score atomically;
- `getPendingStats` supports the health endpoint.

#### `runSettlementSweep` — `src/server/settlement/runner.ts`

Selects due predictions, makes no Coinbase call when there is no work, fetches
one shared quote for the batch, calls `decideSettlement` for each row and then
calls `settlePrediction` for concrete outcomes.

One shared quote makes a batch one market observation. If two sweeps overlap,
one may report `race_lost`; that is expected, not an error.

#### `migrations/001_init.sql`

Know these database guarantees:

- partial unique index: one pending row per player;
- resolved rows must contain complete settlement fields;
- `resolved_at` cannot be earlier than `created_at + 60 seconds`;
- the settlement quote must be later than the entry quote;
- an unchanged price cannot be resolved;
- outcome must agree with direction and price movement.

## Walk through the three main flows

### Create a prediction

```text
POST /api/predictions
  -> validate body and signed cookie
  -> submitPrediction
  -> fetch and validate Coinbase entry quote
  -> INSERT prediction
  -> unique index rejects a concurrent second row
  -> return authoritative state
```

### Read state as an active player

```text
GET /api/state
  -> verify or create identity
  -> runSettlementSweep
  -> read player, active prediction and latest prediction
  -> read display quote
  -> return one no-store snapshot
```

### Settle in the background

```text
cron-job.org POST /api/settle
  -> constant-time secret check
  -> runSettlementSweep
  -> list rows due by database time
  -> fetch one live Coinbase quote
  -> decideSettlement for each row
  -> conditional UPDATE + score UPDATE in one statement
```

## Why the implementation works

Think in invariants rather than endpoints:

| Invariant | Main protection |
| --- | --- |
| Client cannot choose identity | Signed server-issued cookie |
| Client cannot choose price or time | Server provider call and database clock |
| One pending round per player | PostgreSQL partial unique index |
| Nothing settles before 60 seconds | Domain check plus SQL `CHECK` constraint |
| Unchanged price has no result | Pure rule plus SQL `CHECK` constraint |
| Settlement quote follows entry quote | Timestamp/trade checks plus SQL constraint |
| Score changes once | Conditional settlement CTE drives score CTE |
| Provider failure cannot invent a result | All uncertain cases return pending |
| Browser and cron may overlap safely | Both call the same idempotent sweep |

The deliberate duplication between TypeScript and SQL is useful here. TypeScript
returns clear reasons and supports focused tests. PostgreSQL protects persisted
state even if a future caller bypasses part of the service layer.

## Alternatives and trade-offs

### Application-only duplicate check

Simpler at first, but two requests can both observe no active row. The database
index is a smaller and stronger solution.

### ORM instead of handwritten SQL

An ORM could help with ordinary CRUD. Here, the most important operation is a
data-modifying CTE whose transaction shape should be obvious in review. Raw SQL
keeps that behaviour visible, at the cost of manual row mapping.

### One transaction with separate statements

This could also be correct with careful row locking and rollback handling. The
single statement is harder to misuse and naturally makes the score update depend
on the successful status change.

### A timer per prediction

Easy in one process, but timers disappear on restart or redeploy. A stateless
sweep rediscovers work from PostgreSQL.

### A permanent worker

It would give tighter idle settlement latency. It would also add paid or extra
infrastructure for this assignment. Request settlement plus a 15-minute cron is
the explicit €0 compromise.

### Price exactly at second 60

That would require storing a historical market feed or querying an API that can
return the correct point-in-time trade. The current game uses the first eligible
quote observed by a sweep. A delayed sweep can therefore change the outcome.

### Logged-in accounts

Real authentication would make scores portable and harder to reset. It was not
required, so the project uses signed anonymous identity and states that limit.

### Idempotency key for creation

The current unique index prevents two pending predictions. A retry receives a
conflict and current state rather than the original successful response. If the
API required transparent replay, add a client request ID column, a unique
constraint and stored response semantics.

## Common interview questions

### Why is the client not allowed to send the displayed price?

> Because the displayed price is presentation, and it may already be a couple
> of seconds old. At submission time the server fetches its own live quote. That
> makes the recorded entry independent of browser state or tampering.

### Why both an application check and a unique index?

> They do different jobs. The pre-check avoids a provider call and gives a nice
> error. The index handles the race that the pre-check cannot handle.

### What happens if two settlement calls run together?

> Both may inspect the same pending row. The first conditional update changes
> it and drives one score update. The second update no longer matches
> `status = 'pending'`, so it changes nothing.

### Why use the database clock?

> PostgreSQL writes `created_at`, enforces the 60-second constraint and selects
> due rows. Using the same clock avoids disagreements between a Vercel instance
> and the database.

### What happens if Coinbase is down?

> Entry returns a price-unavailable response and creates no prediction. During
> settlement, the prediction stays pending and a later sweep retries. Scores do
> not move without a defensible quote.

### Why does an unchanged price stay pending instead of losing?

> The requirement says the result is based on whether the price changed higher
> or lower. Equality satisfies neither direction. I made that interpretation
> explicit and enforce it in both the rule function and the schema.

### Is the game exactly one minute long?

> Sixty seconds is the minimum, not a guaranteed settlement instant. An active
> browser normally triggers the next sweep within about three seconds. An idle
> game may wait for the 15-minute cron, and that later quote may change the
> result.

### Why not use Vercel Cron?

> The approved target was zero cost on Vercel Hobby, and the chosen external
> scheduler provides the required 15-minute fallback without a paid add-on. The
> endpoint is secret-protected and uses the same tested sweep as browser traffic.

### How do you know the cron really works?

> I created a production prediction, made no state request after creation, and
> observed it remain pending after the deadline. Vercel then logged the cron POST
> with HTTP 200, and Neon showed the row resolved one second later.

### What would you change first at higher traffic?

> I would measure pending volume and settlement latency first. Likely changes are
> a dedicated worker, chunked or locked work claiming, rate limiting, metrics and
> score reconciliation. I would not add them before the load justified them.

### What is the weakest part of the current design?

> The free idle scheduler changes the timing semantics: the result may use a
> much later quote. That is documented, but it is a product compromise. I would
> clarify the desired point-in-time rule before changing infrastructure.

## Small exercises

### 1. Trace one prediction on paper

Start at `Game.submit` and write down every function called before the row is
inserted. For each step, note which values come from the client and which are
created by the server.

You should end with only `direction` coming from the request body.

### 2. Explain the settlement SQL aloud

Open `settlePrediction` in `src/server/game/store.ts`. Explain what happens when
two sessions execute it for the same prediction. Do not use the word “probably”;
point to the `status = 'pending'` condition and the CTE dependency.

### 3. Change a controlled quote in a unit test

In `tests/unit/rules.test.ts`, add a case exactly one millisecond before the
deadline and another exactly at the deadline. Predict the result before running:

```bash
npm run test:unit -- tests/unit/rules.test.ts
```

Remember that the current Vitest global setup still expects a test database.

### 4. Prove the unique index matters

Read the 20-way concurrency test in `tests/integration/store.test.ts`. Temporarily
remove the unique index in a disposable test database and reason about what could
happen. Restore the migration before continuing; do not edit an applied
production migration.

### 5. Exercise provider failure

Use the stub provider in an integration test to throw `PriceProviderError`.
Verify that entry creates no row and settlement leaves an existing row pending.

### 6. Verify identity tampering

Run `tests/unit/identity.test.ts`, then change one character in a signed token
inside a local request. Confirm the server creates a fresh identity rather than
trusting the altered player ID.

### 7. Inspect the live health contract

```bash
curl -s https://bitcoin-prediction-game-khaki.vercel.app/api/health | jq .
```

Explain why `schedulerEnabled: false`, `requestTriggered: true` and
`externalTriggerConfigured: true` are the expected Vercel values.

### 8. Describe a better exact-time product

Sketch how you would settle against the market price at exactly second 60. Think
about historical trade storage, provider guarantees, missing trades and which
timestamp defines the rule. This is a product semantics question before it is an
infrastructure question.

### 9. Add an idempotency-key design on paper

Do not code it first. Define the request ID owner, unique constraint, response to
a repeated ID with the same direction, response to the same ID with a different
direction, expiry and cleanup. Then compare it with the current 409 behaviour.

## Final interview reminder

Do not try to memorise every file. Be able to defend the five decisions at the
top, trace one creation and one settlement, and state the limits without hiding
them. The strongest version of the story is simple: I made the browser
untrusted, put concurrency guarantees in PostgreSQL, kept the outcome rule pure,
made score updates atomic, and documented the timing compromise required by free
serverless hosting.
