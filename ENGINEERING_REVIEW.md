# Engineering review

Review date: 16 October 2026

Branch: `review/engineering-improvements`

Base: `fbe09edb62c9d96aa94967892c6295139eb68344`

This review looks for a small set of changes worth defending in an interview.
It does not redesign the game, change its scoring rules or add infrastructure.

## Executive assessment

The important correctness properties are in good shape. The browser submits
only a direction, PostgreSQL prevents two pending predictions for one player,
and settlement changes the prediction and score in one conditional statement.
The tests exercise those properties against real PostgreSQL, including
concurrent creation and settlement.

The weakest part is timing rather than scoring. Sixty seconds is a lower bound,
not an exact observation point. An active browser normally triggers settlement
soon after the deadline. If it closes, the 15-minute cron fallback can use a
later market price and produce a different result from the price at second 60.
That behaviour is documented and internally consistent, but it is a product
compromise that should be explained plainly.

At 10,000 concurrent players, request amplification is the first area to
measure. Active clients poll every three seconds, which is about 3,333 state
requests per second before retries. Each warm server process has a small
database pool, and both the display-price cache and the new sweep overlap guard
are process-local. The implementation is concurrency-safe, but that does not
establish a capacity number.

## Confirmed issues

### Malformed cookie encoding returned a server error

`readCookie` called `decodeURIComponent` without handling invalid escape
sequences. A request containing `bpg_player=%E0%A4%A` could therefore fail
before token verification instead of being treated as an invalid anonymous
session.

The reproduction is now an integration test in
`tests/integration/http.test.ts` and a focused unit test in
`tests/unit/identity.test.ts`.

### A failed first prediction could lose the newly issued identity

On a first request, `handleCreatePrediction` creates an anonymous identity
before asking Coinbase for an entry quote. When the provider returned an error,
the `503` response omitted `Set-Cookie`. Retrying without a cookie created
another player row even though no prediction had started.

The new test sends a valid first prediction through a failing provider, retries
with the returned cookie and verifies that only one player exists.

### The initial-load error screen was unreachable

`Game.tsx` rendered a dedicated initial error state, but neither the non-2xx
path nor the network-error path assigned `initialLoadError`. A failed first
request left the UI on the loading skeleton indefinitely.

This was confirmed by tracing every write to `initialLoadError`. The fix is
small and is covered by typecheck, lint and the production build. A browser
test dependency was not added for this one state transition.

### Overlapping triggers duplicated settlement work in one process

The atomic SQL already prevented double scoring, but `handleState` and
`handleSettle` each started an independent sweep. When they overlapped in one
warm instance, both could select the same batch and call Coinbase.

The original HTTP race test expected two provider calls, which confirmed the
duplication. The updated tests distinguish one-process overlap from
cross-instance overlap.

## Improvements implemented

### 1. Recover malformed anonymous cookies

- **Problem:** invalid percent-encoding could return 500.
- **Change:** `readCookie` returns `null` when decoding fails. Existing identity
  logic then issues a fresh signed cookie.
- **Alternative considered:** reject the whole request with 400. That would make
  a recoverable, client-controlled cookie problem visible to the player without
  improving security.
- **Files:** `src/server/identity.ts`, `tests/unit/identity.test.ts`,
  `tests/integration/http.test.ts`.
- **Result:** unit and HTTP tests pass.
- **Recommendation:** **MERGE**.

### 2. Preserve identity on known prediction failures

- **Problem:** a first-time player's cookie was lost when entry failed after
  identity resolution.
- **Change:** known and unexpected errors after identity resolution include the
  newly issued cookie. Invalid request bodies still do not create an identity.
- **Alternative considered:** delay player creation until after the provider
  call. That spreads identity lifecycle concerns into the game service and does
  not help other post-identity failures.
- **Files:** `src/server/http/handlers.ts`, `tests/integration/http.test.ts`.
- **Result:** a provider failure returns 503, creates no prediction and keeps
  one stable player across retry.
- **Recommendation:** **MERGE**.

### 3. Coalesce settlement work within a warm instance

- **Problem:** request and cron overlap made duplicate database and Coinbase
  calls even though only one settlement could commit.
- **Change:** handlers share one in-flight sweep promise. This is an
  optimisation, not a new correctness mechanism.
- **Alternative considered:** a distributed lock or a claimed-work schema.
  Both add state and failure modes that are not justified for this assignment.
- **Files:** `src/server/http/handlers.ts`, `tests/integration/http.test.ts`.
- **Result:** same-instance overlap makes one provider call. Two independent
  handler graphs still race safely and update the score once.
- **Remaining trade-off:** separate Vercel instances cannot share this promise.
  If a shared sweep fails, both callers observe that attempt's failure and the
  next request retries.
- **Recommendation:** **MERGE**.

### 4. Make polling reflect visible work

- **Problem:** idle and hidden tabs polled every three seconds, creating work
  that could not improve the player's immediate experience.
- **Change:** active rounds poll every three seconds, idle screens every ten
  seconds, hidden tabs pause, and visibility restoration refreshes immediately.
  Initial request failures now reach the existing retry screen.
- **Alternative considered:** server push. It would add infrastructure and does
  not solve the settlement timing rule.
- **Files:** `src/app/Game.tsx`.
- **Result:** typecheck, lint and production build pass. No capacity improvement
  is claimed without a load test.
- **Recommendation:** **MERGE**.

### 5. Align the documentation with the code

The README remains the short entry point. The decision journal now records the
identity, overlap and polling choices. The walkthrough and study guide reflect
the two levels of concurrency protection and do not turn verification performed
through this review into fabricated personal experience.

- **Files:** `README.md`, `DECISIONS.md`, `WALKTHROUGH.md`, `STUDY_GUIDE.md`,
  `AGENTS.md`, `ENGINEERING_REVIEW.md`.
- **Recommendation:** **MERGE**.

## Improvements deliberately not implemented

### Exact-deadline settlement — DO NOT MERGE without a product decision

If the browser closes, the current cron eventually evaluates a fresh quote.
That quote may be much later than the deadline and can reverse the outcome. A
flat price or Coinbase outage leaves the round pending until a later usable
price arrives.

Running the existing cron more often narrows the delay but does not define “the
price at exactly second 60.” Exact point-in-time settlement needs a clear rule
for which trade or interval represents the deadline and a market-data source
that can retrieve it later. That changes game semantics, so it was not
implemented silently.

There is a smaller free operational improvement available after review:
cron-job.org documents free execution as often as once per minute, while Vercel
Hobby's own cron is limited to once per day. Changing the existing external job
from 15 minutes to one minute would reduce unattended delay without changing
application code, although the service does not guarantee exact punctuality.
No production schedule was changed in this branch.

- [cron-job.org frequency and timing FAQ](https://cron-job.org/en/faq/)
- [Vercel cron usage and Hobby limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- **Recommendation:** **OPTIONAL** operational change after approval.

### Distributed rate limiting — DO NOT MERGE for this take-home

There is no request rate limiter. The pending-row index limits game state per
identity, but clearing a cookie creates another identity and does not protect
Coinbase or the state endpoint from request volume.

An in-memory limiter would be inconsistent across Vercel instances and easy to
bypass. A database limiter would put more writes on the likely bottleneck and
requires a defensible client key, expiry policy and privacy decision. The first
step should be measuring traffic and using platform controls for obvious abuse;
a shared application limiter follows only if the evidence supports it.

### Creation idempotency key — OPTIONAL

The unique index guarantees at most one pending row, and duplicate submissions
return the authoritative active state. It does not replay the original success
response after an ambiguous client timeout. A request ID column and unique
constraint would provide that stronger contract, but it needs an API and
migration change. It is useful product work, not a necessary correctness fix
for this submission.

### Larger settlement worker or queue — DO NOT MERGE yet

A dedicated worker, queue or lease-based claim system would help a large
backlog, but adds infrastructure the assignment explicitly does not need. The
current batch size is 25 and each successful candidate is updated separately.
Measure backlog behaviour before selecting the next design.

### Playwright — OPTIONAL

The HTTP contract and database behaviour have strong coverage. A tiny browser
suite could add confidence around the initial error screen, keyboard focus,
hydration and the primary mobile flow. Adding a framework and browser download
for a handful of checks was not justified during this review.

## Scalability assessment

Ten thousand active players imply roughly 3,333 state requests per second at a
three-second interval. Ten thousand idle visible players now imply roughly
1,000 requests per second; hidden tabs make none. A state request runs a sweep
selection and then reads player, active-prediction and latest-prediction state.
The application pool defaults to two connections per Vercel process and uses a
pooled Neon URL.

The likely first bottleneck is the combination of polling and database/provider
amplification, not the score-update race itself:

- every serverless instance has its own display-price cache;
- sweep coalescing works only inside one process;
- several instances can select the same oldest 25 due rows;
- one sweep uses one Coinbase quote but performs settlement writes one by one;
- a large due backlog can leave a player's row outside the first batch;
- provider timeouts and 429 responses keep work pending, which increases the
  next sweep's backlog.

That is a reason to test, not a measured capacity conclusion. A realistic test
would use an isolated database branch and a controlled price provider, then
ramp state and prediction traffic while recording:

- request throughput and p50/p95/p99 latency;
- Vercel concurrency and function errors;
- pool wait time, active PostgreSQL connections and query latency;
- Coinbase calls, timeouts and 429 responses as a separate provider test;
- sweep `examined`, `settled`, `race_lost` and `settlement_sweep_joined` counts;
- pending-row count and oldest pending age.

The test should ramp through 100, 500, 1,000 and then 10,000 simulated players
rather than jump straight to the largest number. A local/container run can use
the simulated provider for the application limit; a much smaller controlled
test should probe Coinbase behaviour without treating its public endpoint as a
load-test target.

## Security and abuse review

Confirmed protections:

- player identity is random, HMAC-signed, `HttpOnly` and verified server-side;
- game requests cannot supply identity, price, time or score changes;
- prediction bodies are bounded and direction is validated;
- the settlement endpoint is disabled without a secret and compares the
  configured secret in constant time;
- game responses use `Cache-Control: no-store` and errors avoid database or
  secret details;
- database, cookie and settlement credentials stay server-side.

Hardening opportunities rather than confirmed defects:

- rate limiting and bot controls;
- creation idempotency keys;
- metrics and alerting for old pending rows and provider failures;
- periodic score reconciliation;
- secret rotation procedures for the external scheduler account.

## Interview discussion points

1. **Why is settlement atomic, and what happens in a cross-instance race?**

   Open `src/server/game/store.ts` and `tests/integration/game-loop.test.ts`.
   Discuss the conditional update, data-modifying CTE and why process-local
   coalescing cannot replace the SQL guarantee.

2. **What does “after one minute” mean when the browser is closed?**

   Open `src/domain/rules.ts`, `src/server/settlement/runner.ts` and
   `src/server/http/handlers.ts`. Discuss lower-bound timing, later quotes,
   unchanged prices and outages.

3. **What breaks first at 10,000 players, and how would you prove it?**

   Open `src/app/Game.tsx`, `src/server/db/pool.ts`,
   `src/server/prices/cached.ts` and `src/server/game/store.ts`. Separate
   correctness under concurrency from capacity under load.

4. **What security property does the anonymous cookie provide?**

   Open `src/server/identity.ts`. Explain that signing prevents impersonation
   of a known player but does not prevent someone creating fresh identities.

5. **Why not add Redis, a queue or Playwright during this review?**

   Discuss evidence, scope and the cost of extra moving parts. Explain which
   measurement or product requirement would change the decision.

## Verification results

Baseline before implementation:

```text
npm run typecheck  PASS
npm run lint       PASS
npm test           170 passed across 10 files
```

The first sandboxed `npm test` attempt could not reach
`127.0.0.1:55432`; the local PostgreSQL server was not running. A short-lived
Neon child branch named `review-engineering-improvements-test` was created from
`production`, and passed its connection string only through the process
environment. The branch expires automatically on 18 October 2026. Production
credentials, data and environment files were not changed.

Initial review verification:

```text
npm run typecheck  PASS
npm run lint       PASS, 0 warnings
npm test           PASS, 174 tests across 10 files
npm run build      PASS, Next.js 15.5.28 production build
git diff --check   PASS
```

The three confirmed follow-up defects were then corrected on the review branch:
the concurrent unique-index loser now maps to HTTP 409, `ensurePlayer` retries
its read with a fresh statement snapshot, and the smoke test accepts both valid
score directions. The two deterministic regression tests brought the suite to
176 passing tests across the same 10 files. Typecheck, lint and the production
build passed again after those changes.

The test run emitted the `pg` package's forward-looking warning about upcoming
`sslmode=require` semantics. It did not fail the run. No deployment, production
cron change or production database mutation was performed.

## Merge recommendation

| Change | Recommendation | Reason |
|---|---|---|
| Malformed-cookie recovery | **MERGE** | Fixes a verified 500 path |
| Preserve identity on entry failure | **MERGE** | Prevents avoidable orphan player rows |
| Same-instance sweep coalescing | **MERGE** | Reduces verified duplicate work without changing correctness |
| Initial-load error and adaptive polling | **MERGE** | Fixes a dead UI state and removes avoidable requests |
| Documentation alignment | **MERGE** | Keeps claims and implementation consistent |
| One-minute external cron | **OPTIONAL** | Free and lower latency, but operational and not exact-time |
| Creation idempotency key | **OPTIONAL** | Stronger retry semantics, but needs contract and schema work |
| Playwright smoke tests | **OPTIONAL** | Useful browser confidence, not required for the core rules |
| Distributed limiter, queue or worker | **DO NOT MERGE** | No load evidence justifies the added infrastructure |
| Exact-deadline outcome rule | **DO NOT MERGE** | Requires an explicit product semantics decision |

The branch is suitable for review. The recommendation is to merge the five small changes
classified **MERGE** and discussing the one-minute cron separately because it
changes production operations rather than repository code.
