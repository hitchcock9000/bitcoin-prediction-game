# Engineering decisions

A running log, written as decisions were made. Each entry records the context,
the choice, the alternative that was rejected, and the honest trade-off. Where a
decision was informed by an experiment, the commands and results are included.

Ordered oldest first.

---

## D1 — One pending prediction per player is enforced by a partial unique index

**Context.** Business rule 4 says a player may have only one active prediction.
The obvious implementation in a service layer is:

```ts
const existing = await getActivePrediction(playerId);
if (existing) throw new ConflictError();
await insertPrediction(...);
```

That is a check-then-act sequence. Two concurrent requests can both read "no
pending prediction" and both insert.

**Decision.** Enforce the rule in the database:

```sql
create unique index predictions_one_pending_per_player
  on predictions (player_id) where status = 'pending';
```

The service still performs the check, but only as a cheap pre-check for a
friendly error message. The index is the guarantee. A `23505` violation on that
specific constraint is translated into a domain error and returned as HTTP 409.

**Alternative considered.** `SELECT ... FOR UPDATE` on the player row, or a
transaction-level advisory lock per player. Both work, but both require holding
a lock across an external HTTP call to the price provider, and both are more
code for the same outcome.

**Experiment (run before writing the application, against PostgreSQL 16.2).**

```
create unique index probe_one_pending on probe (player_id) where status = 'pending';

-- 20 truly parallel inserts for the same player, via Promise.all
parallel inserts succeeded (want 1): 1
-- duplicate insert error: code 23505, constraint probe_one_pending
```

The same experiment is preserved as an automated test
(`tests/integration/store.test.ts` → "lets exactly one of 20 concurrent
creations win"), so the guarantee stays verified rather than merely asserted.

**Trade-off.** The index is partial, so it constrains only pending rows. That is
the intent, but it means the rule "one *active* prediction" is defined by
`status = 'pending'` — if a future feature added a third status, this index
would need revisiting.

**Files.** `migrations/001_init.sql`, `src/server/game/store.ts`,
`tests/integration/store.test.ts`.

---

## D2 — Coinbase Exchange is the price provider

**Context.** The assignment requires real BTC/USD prices and *fair* settlement.
Fairness forced a requirement that was not obvious at first: we need a
timestamp that belongs to the quote, not to our own request. Without it, the
60-second rule and "the price has changed" would both be measured against our
own clock, and we would have no way to tell a fresh quote from a cached one.

**Decision.** `GET https://api.exchange.coinbase.com/products/BTC-USD/ticker`.

**Alternatives considered, with the evidence that ruled them out:**

| Provider | Verdict |
| --- | --- |
| Binance `BTCUSDT` | Rejected. Not a USD pair, and the live call returned `{"code":0,"msg":"Service unavailable from a restricted location..."}` — an outage that depends on where the app is deployed. |
| Coinbase `/v2/prices/BTC-USD/spot` | Rejected. Correct pair, but the response is `{"data":{"amount":"82232.055",...}}` — **no timestamp at all**, so every timing decision would rest on our own clock. |
| Kraken `Ticker?pair=XBTUSD` | Rejected. Response confirmed live, but again carries no quote timestamp (only trade counts and OHLC buckets). |
| Provider aggregator (CoinGecko etc.) | Rejected. Introduces an extra hop and a second set of freshness semantics for no gain at this scale. |

The chosen endpoint returns, verified against the live API during design:

```json
{"ask":"82189.17","bid":"82189.16","volume":"7152.80223161",
 "trade_id":1106664073,"price":"82190.33","size":"0.00006019",
 "time":"2026-10-15T21:28:06.113600557Z"}
```

This gives a genuine `BTC-USD` pair, a provider timestamp, a monotonic
`trade_id`, no API key, and no region restriction.

**Trade-off.** Single venue, not a cross-exchange index. A thin venue can in
principle print a wick that a composite price would smooth out. For a 60-second
UP/DOWN game the disagreement between venues is far below the movement the game
is measuring, and consistency matters more than breadth: the same source is used
for entry and settlement, which is what makes the comparison meaningful.

**Files.** `src/server/prices/coinbase.ts`, `tests/unit/coinbase.test.ts`.

---

## D3 — A long-running process with an in-process scheduler, not serverless

**Context.** A prediction must resolve whether or not the player keeps the page
open. A per-request check cannot guarantee that: the player may close the tab and
never return. Something server-side has to drive resolution on a timer.

**Decision.** Deploy as a long-running Node process (Docker container on a
container host such as Railway or Render) and run the settlement sweep on a
`setInterval` inside that process. The sweep is stateless — it discovers work by
querying for pending predictions whose window has elapsed — so it also runs on
boot, which is what makes restarts recover rather than lose work.

**Alternatives considered:**

- **Per-prediction `setTimeout` in memory.** Rejected: dies on restart or
  redeploy, silently stranding the prediction with no way to notice.
- **Serverless + platform cron (e.g. Vercel cron).** Viable, and the code
  supports it: `POST /api/settle` runs the same sweep. But on free/serverless
  tiers the minimum schedule granularity is minutes, so a 60-second game would
  settle late by design. Documents a degraded experience rather than avoiding it.
- **AWS EventBridge + SQS + worker.** Rejected as over-engineering for a
  half-day exercise. It is the right answer at much higher volume (D15).
- **Database-level scheduling (pg_cron).** Rejected: requires an extension that
  managed Postgres tiers may not expose, and it moves business rules into SQL
  where they are harder to test.

**Trade-offs, stated plainly (these are real limitations):**

1. **Suspension.** On a host that idles containers to zero, ticks do not fire
   while suspended. Predictions settle late. They never settle *incorrectly*,
   because eligibility is computed from the stored `created_at`, so the first
   tick after waking resolves everything overdue.
2. **Restart.** Nothing is held in memory. Pending work lives in Postgres.
3. **Multiple instances.** Safe but redundant: two schedulers racing is resolved
   by the conditional settlement update (D4) — one wins, the other becomes a
   no-op. The cost is N provider polls per tick, so
   `SETTLEMENT_SCHEDULER_ENABLED=false` exists to disable the scheduler on all
   but one instance.
4. **Single point of failure.** If the process is down, nothing settles until it
   is back.

**Files.** `src/server/settlement/scheduler.ts`,
`src/server/settlement/runner.ts`, `src/instrumentation.ts`.

---

## D4 — Settlement is one conditional UPDATE, so it cannot score twice

**Context.** Settlement has three possible callers (the scheduler, an
opportunistic API-triggered sweep, and an external cron hitting `/api/settle`).
Any of them can overlap. The failure mode — a player scored twice for one
prediction — is silent and corrupts the product.

**Decision.** Settling is a single statement:

```sql
with settled as (
  update predictions
     set status = 'resolved', outcome = $2, settlement_price = $3, ...
   where id = $1 and status = 'pending'
  returning player_id, outcome
), scored as (
  update players p
     set score = p.score + case when s.outcome = 'win' then 1 else -1 end
    from settled s where p.id = s.player_id
  returning p.score
)
select (select count(*) from settled)::int, (select score from scored)
```

The score update is *driven by the rows the status update actually returned*.
There is no window between "check the status" and "add a point". Both CTEs run in
one statement, so the status change and the score change commit together or not
at all. A loser in a race gets `settled: false`, which is a normal outcome, not
an error.

**Experiment (PostgreSQL 16.2, before implementation).**

```
update probe set status='resolved' where player_id=1 and status='pending' returning id;
conditional update rowCounts: 1 0   -- second call matched nothing
```

Automated today: `tests/integration/store.test.ts` (repeated and ×10 concurrent
settlement) and `tests/integration/game-loop.test.ts` (two racing sweeps).

**Alternative considered.** `SELECT ... FOR UPDATE` then branch in application
code. Correct, but it needs an explicit transaction, more round trips, and it
puts the atomicity in the caller's hands rather than in one statement.

**Trade-off.** The score is now changed by SQL rather than by TypeScript. The
mitigation is a `CHECK` constraint that makes an inconsistent `(direction,
entry_price, settlement_price, outcome)` row impossible (D7), so the SQL cannot
silently produce a rule-breaking result.

**Files.** `src/server/game/store.ts` (`settlePrediction`),
`migrations/001_init.sql`.

---

## D5 — The database clock is the clock of record for the 60-second rule

**Context.** `created_at` was already going to be a database default, and the
"no early resolution" check compares `resolved_at` against `created_at + 60
seconds`. If the scheduler selected candidates using the *application* clock
while the constraint validated them against the *database* clock, then clock
drift between two machines could either make the constraint reject a legitimate
settlement, or make the sweep sit idle on work that was actually due.

**Decision.** Time-based decisions at settlement use the database clock:

- `created_at` and `resolved_at` are both written by the database.
- The sweep selects due predictions with
  `created_at + make_interval(secs => $1) <= now()` — both sides in the database.
- The same `now()` value is returned to the caller and used as the `now` input
  for the settlement decision.

So the app server does not need to be clock-synchronised with the database for
the game to be fair. The one place the application clock is still used is entry
quote freshness (`evaluateEntryQuote`), where the budget is 15 seconds and
second-level accuracy is irrelevant.

**Trade-off.** The settlement decision depends on a database round trip, and a
pure unit test of the runner needs the database. That is why the decision
function itself is a pure function taking `now` as an argument — the clock
question is isolated to the store layer, and the rules remain unit-testable.

**Files.** `src/server/game/store.ts` (`listSweepable`),
`src/server/settlement/runner.ts`, `migrations/001_init.sql`.

---

## D6 — Prices are exact decimal strings, never floats

**Context.** Points are awarded by comparing two prices. IEEE-754 doubles cannot
represent most decimal fractions exactly (`0.1 + 0.2 !== 0.3`), so comparing
prices as `number` would be approximately correct — which is not good enough for
something that moves a score.

**Decision.** Prices are `NUMERIC(18,8)` in Postgres; `pg` returns them as
strings; the provider's `price` string is passed through untouched; comparisons
go through `compareDecimal`, which scales both operands to a common number of
decimal places and compares `BigInt`s.

**Finding while writing tests.** Postgres normalises `NUMERIC` to the *declared*
scale, so a price submitted as `80000.00` reads back as `80000.00000000`. This
is harmless for correctness (comparison normalises scale) but wrong for display,
so `trimDecimal` normalises presentation paths. Test assertions compare prices
with `decimalsEqual` rather than string equality, because string equality would
be asserting an implementation detail of the column type.

**Alternative considered.** Store integer cents, or a float with a rounding
step. Integer cents would be simplest if prices were always 2 decimals, but a
BTC price can legitimately carry more, and the game should not invent a
precision limit. Floats were rejected outright.

**Trade-off.** Slightly more ceremony than `number`, and every price crossing a
boundary is a string, which is easy to misuse (`'9' > '10'` is `true` for
strings). The mitigation is that comparison is only available through
`compareDecimal` / `decimalsEqual`, and `tests/unit/decimal.test.ts` pins the
behaviour including malformed input.

**Files.** `src/domain/decimal.ts`, `migrations/001_init.sql`,
`tests/unit/decimal.test.ts`.

---

## D7 — Business invariants are duplicated as database CHECK constraints

**Context.** The pure decision function already refuses to produce a result for
an unchanged price, and already requires 60 seconds to have elapsed. Relying on
that alone means one future code path — a script, a migration, a bug fix under
time pressure — could write a rule-breaking row.

**Decision.** Encode the rules the database can check:

| Invariant | Enforcement |
| --- | --- |
| At most one pending prediction per player | Partial unique index (D1) |
| Direction is `up` or `down` | `CHECK` |
| Status is `pending` or `resolved` | `CHECK` |
| Resolved rows carry full settlement data; pending rows carry none | `CHECK` (`predictions_settlement_completeness`) |
| No resolution before 60 seconds | `CHECK` (`predictions_no_early_resolution`) |
| Settlement quote strictly later than entry quote | `CHECK` |
| Outcome matches the price movement | `CHECK` (`predictions_outcome_matches_price_movement`) |
| Score is only moved once per prediction | Conditional `UPDATE` (D4) |

**Finding, and a bug this caught.** The first version of the outcome constraint
was:

```sql
(outcome = 'win') = (case direction when 'up' then settlement_price > entry_price ... end)
```

While writing the tests for it, it became clear this permits an **unchanged**
price to be scored as a `loss`: `(outcome = 'win')` is `false` and
`(entry_price > entry_price)` is also `false`, so the biconditional holds. The
constraint now also requires `settlement_price <> entry_price`. The regression
test is `tests/integration/store.test.ts` → "refuses to score an unchanged price
as a loss". The migration had not been applied anywhere yet, which is why it
could be corrected in place.

**Trade-off.** Rules now live in two places, and they can drift. Accepted
knowingly: the pair is exercised by the same test suite, and a drift shows up as
a failing integration test rather than as a wrong score. The alternative — rules
only in SQL — would make them hard to unit test; rules only in TypeScript would
leave the database able to store impossible states.

**Files.** `migrations/001_init.sql`, `tests/integration/store.test.ts`.

---

## D8 — Refuse to guess: no quote means no prediction, no movement means no result

**Context.** Several situations have no correct answer available: the provider is
down, the quote is stale, or the price has not moved since the prediction was
placed. Each could be resolved "helpfully" — reuse the last known price, treat
unchanged as a loss, retry until something moves — and each of those choices
would be inventing an outcome.

**Decision.** Fail closed, and report why:

- No usable quote at entry → **no prediction is created** (stale or unreliable
  entry price would corrupt the whole round). HTTP 503 with a reason.
- No quote, stale quote, or future-dated quote at settlement → **stay pending**.
  The score is untouched and the prediction is retried next sweep.
- Price unchanged → **stay pending** until a later quote actually moves. The
  player sees "the price has not moved yet" rather than a fabricated loss.

Every refusal is a named reason (`PendingReason`) surfaced through the API and
rendered in the UI, so the state is explainable rather than a spinner.

**Trade-off.** A prediction can stay open longer than a minute — indefinitely, if
the market genuinely does not move (easier to hit with a low-precision price
than one might expect). This is the honest reading of the rules: the assignment
says a prediction resolves when the price has *changed*, and says unchanged
prices must not be treated as wins or losses. The cost is a player who cannot
play until the market ticks, which is acceptable for BTC/USD and would need
rethinking for a thinner market.

**Files.** `src/domain/rules.ts` (`decideSettlement`),
`src/server/game/service.ts`, `tests/integration/game-loop.test.ts`.

---

## D9 — Player identity is a server-signed cookie, not a client-supplied id

**Context.** Requirement: the backend owns player identity, and a client must
never be able to assert who it is. The frontend must not be trusted to determine
outcomes or update scores — which also means it must not be trusted to *name*
the player whose score it is about to read or modify.

**Decision.** The server mints a random UUID on first contact, signs it with
HMAC-SHA256 using `PLAYER_COOKIE_SECRET`, and returns it as an `HttpOnly`,
`SameSite=Lax`, `Secure`-in-production cookie:

```
bpg_player = <uuid>.<issuedAtMs>.<base64url(hmac)>
```

Every request verifies the signature (timing-safe comparison) before the id is
used. The API never accepts a player id from a request body, query string, or
header.

**Alternatives considered:**

- **An id in `localStorage`.** Rejected: fully client-controlled, and trivially
  forged by editing devtools — a player could read or spend another player's
  prediction.
- **Accepting an id from the request body.** Rejected: same problem, and it is
  exactly the "client-supplied player id" the requirements forbid trusting.
- **A server-side session table.** Rejected as unnecessary: the signed cookie
  gives the same integrity without an extra table and an extra lookup per
  request. It would be needed if we wanted server-side revocation.
- **Real authentication.** Out of scope for the assignment, and it would change
  the product (anonymous play is a feature here).

**Limitation, stated honestly.** This is integrity, not authentication. A player
who clears their cookie gets a new identity and starts from zero, and nothing
stops somebody from creating many identities. The signature prevents
impersonating a *specific existing* player; it does not prevent playing
anonymously as a new one. Closing that would require a real account system,
which is outside the assignment's scope.

**Files.** `src/server/identity.ts`, `tests/unit/identity.test.ts`.

---

## D10 — Simulated prices cannot reach production by accident

**Context.** The development environment used for this project has no outbound
access to market data APIs (verified: Coinbase, Kraken, Binance and CoinGecko all
failed to connect). To run and demonstrate the application anyway, a simulated
provider is needed. That is a genuine deployment risk: a demo mode that silently
serves fake prices to real players would make the game meaningless.

**Decision.** Three independent guards:

1. `loadConfig` throws if `PRICE_PROVIDER=simulated` while
   `NODE_ENV=production`, unless `ALLOW_SIMULATED_PRICES=true` is deliberately
   set.
2. The provider reports `simulated: true`, and the API includes that flag in its
   responses so the UI can show a visible "simulated prices" marker.
3. Real prices are the default: the provider selection is opt-in and
   `coinbase` is used when nothing is configured.

Tested in `tests/unit/config.test.ts` (production + simulated is refused; the
explicit opt-in is honoured).

**Trade-off.** Simulated mode exists in the shipped codebase at all. The
alternative — keeping it out of `src/` entirely — would have made the deployed
demo unverifiable. The guards and the visible label are the mitigation, and the
scope is documented in README "Known limitations".

**Files.** `src/server/prices/simulated.ts`, `src/server/config.ts`,
`tests/unit/config.test.ts`.

---

## D11 — One quote per sweep, shared by every prediction in that sweep

**Context.** The sweep can find several predictions that came due in the same
tick. Fetching a fresh quote per prediction is the obvious implementation, and it
means two players who reached their deadline milliseconds apart could be scored
against different prices.

**Decision.** Fetch one quote per sweep and use it for the whole batch. The
sweep becomes a single, consistent observation of the market, and the provider
timestamp recorded on each row keeps it auditable.

**Trade-off.** With a large batch, an early prediction in the batch is settled
using a price up to one sweep interval after its own deadline (bounded by the
5-second tick, and by `RULES.settlementBatchSize`). For a 60-second game with a
5-second tick this is well inside the noise. At higher volume the batch would
need chunking and the trade-off would have to be revisited (D15).

**Files.** `src/server/settlement/runner.ts`.

---

## D12 — Settlement quote must be strictly newer, checked by timestamp and trade id

**Context.** "The settlement price must be genuinely later than the entry
price" is not the same as "we fetched it later". A provider (or a cache in front
of it) can serve a payload that is older than the entry quote while our request
was made later.

**Decision.** Two guards in `decideSettlement`: the settlement quote's timestamp
must be strictly greater than the entry quote's, and — when both quotes carry a
`trade_id` — the settlement trade id must be strictly greater too.

**Finding: the timestamp guard is unreachable with the current constants.** A
settlement quote must be within `settlementQuoteMaxAgeMs` (30s) of `now`, while
the deadline is 60s after creation and the entry quote is at most a few seconds
after creation. Therefore any quote that passes the freshness check is
necessarily newer than the entry quote, and the timestamp branch cannot fire in
production. This surfaced as a failing test whose assertion was wrong, not as a
bug in the code.

It is kept as defence in depth (the function must stay safe for inconsistent
input, and the constants may be retuned), and it is tested as a pure-function
contract with deliberately inconsistent input, with a comment in the test
explaining the reachability analysis. The **trade-id guard is reachable**, and it
was in fact the cause of a fixture bug during development: the test stub shared a
default trade id with the backdated entry fixture, and settlement correctly
refused to proceed. That is recorded in the helper's comment because it is a
useful demonstration that the guard is not decorative.

**Files.** `src/domain/rules.ts`, `tests/unit/rules.test.ts`,
`tests/helpers/stubPriceProvider.ts`.

---

## D13 — Raw SQL in one module, no ORM

**Context.** The invariants that matter here (partial unique index, conditional
update, `CHECK` constraints, `NUMERIC` scale) are database features. Whatever
sits in front of them must not obscure them.

**Decision.** `src/server/game/store.ts` holds every query in the project,
hand-written, with `pg` and a small manual row mapper. No ORM, no query builder.

**Alternatives considered.** Prisma or Drizzle would generate migrations and
types, and would be the pragmatic choice for a larger schema. Here the entire
persistence surface is two tables and seven queries, and the most important
query is one the ORM would have made *harder* to express and to read (a
data-modifying CTE that updates two tables).

**Trade-off.** Row mapping is manual: `NUMERIC` and `BIGINT` arrive as strings
and must be converted deliberately (`entryTradeId`, `settlementPrice`). Rows are
mapped in exactly one place, and the integration tests exercise every query
against real Postgres, so a mapping mistake fails loudly rather than silently.

**Files.** `src/server/game/store.ts`.

---

## D14 — Score is stored on the player and auditable from the prediction rows

**Context.** Scores must persist. Storing a single `score` integer is the
simplest thing that works, but it is also opaque: if a score looks wrong, there
is nothing to compare it against.

**Decision.** Store `players.score` as the fast path, *and* keep every resolved
prediction with its entry price, settlement price, outcome and timestamps. A
player's score must always equal `count(win) - count(loss)` over their resolved
predictions, which makes the value reconstructable and every point explainable
after the fact. The prediction rows incidentally provide the per-player history
needed for debugging a reported dispute.

**Trade-off.** Two sources of truth, which can in principle disagree. A
reconciliation query is cheap and is noted in README "Known limitations" as an
operational check rather than something enforced by a constraint (`CHECK`
constraints cannot span tables; a trigger could, and would be more machinery
than this earns).

**Files.** `migrations/001_init.sql`, `src/server/game/store.ts`.

---

## D15 — Test against a real PostgreSQL, and prioritise rules over UI

**Context.** The guarantees under test are database behaviour. A fake or
in-memory database would let the suite pass while the real constraints were
missing or wrong — the tests would be describing an intention rather than a
behaviour.

**Decision.** Integration tests run against a real PostgreSQL instance (16.2 in
this environment) and manipulate time by backdating `created_at` rather than by
sleeping, so the 60-second boundary is tested exactly rather than
approximately. Unit tests stay pure (no database) and cover the decision
function exhaustively with a controllable clock.

**Trade-off.** The test suite requires a database to be running, which is a
setup burden for a reviewer. Handled with an explicit, loud failure and
instructions in README ("Running tests") — and deliberately *not* with a
"skip if no database" escape hatch, because a silently skipped test is worse
than a failing one.

**Files.** `tests/global-setup.ts`, `tests/helpers/db.ts`, `vitest.config.ts`.

---

## Open questions / not yet decisions

- **Vertical scaling.** At ~10,000 players the per-tick sweep would need
  chunking by player id, and the settlement decision would likely move to a
  queue-driven worker. Not implemented; described in WALKTHROUGH.md "next
  iteration".
- **Rate limiting.** There is currently no rate limit on `POST /api/predictions`.
  The partial unique index bounds the *damage* (a player can have at most one
  pending prediction, so they cannot farm predictions), but nothing bounds
  request volume. See README "Known limitations".
- **Reconciliation job.** A scheduled check that `players.score` still equals
  the resolved-prediction tally. Not implemented.
