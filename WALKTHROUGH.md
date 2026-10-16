# Engineering walkthrough

This is a 20-minute presentation guide, not a script to memorise. Every talking
point maps to a current file, test or recorded deployment check. Before the
interview, follow the code paths yourself and keep only the wording that feels
natural.

## Suggested timing

| Time | Topic |
| --- | --- |
| 2 min | What the game does and where the risk is |
| 3 min | Live demo |
| 5 min | Architecture and ownership boundaries |
| 6 min | Three code paths worth opening |
| 4 min | Tests, trade-offs and next steps |

## 1. Open with the problem, not the stack

A natural opening could be:

> This is a one-minute BTC/USD prediction game. The player sees a price and
> score, chooses higher or lower, and gets one point for a correct prediction or
> loses one for an incorrect one.
>
> The UI is intentionally small. The interesting part is keeping the rules true
> when requests overlap, the browser refreshes, Coinbase is unavailable, or a
> settlement trigger runs twice. The design rule is simple: the browser asks and
> the server decides.

Two assumptions shape the rest of the system:

- **Sixty seconds is a minimum, not an exact capture time.** The first eligible
  sweep uses a fresh quote observed after the deadline.
- **An unchanged price has no outcome.** It is neither higher nor lower, so the
  prediction remains pending until a later eligible quote moves.

The second rule can keep a prediction open longer than a minute. That is a
product trade-off, not something hidden in the implementation.

## 2. Live demo

Use the public app: https://bitcoin-prediction-game-khaki.vercel.app

1. Open the page and point out the live Coinbase source, latest price and score.
2. Choose **Higher** or **Lower**. The response shows the server-recorded entry
   price and starts the countdown.
3. Explain that the countdown is presentation. It never decides eligibility.
4. Try a second prediction in another tab or with `curl`. The database rule
   produces `409`, and the response includes current state so the UI can recover.
5. Wait through the threshold. Active polling calls `/api/state`, which runs the
   settlement sweep before reading state.
6. Refresh after resolution. The cookie identifies the same player and the score
   comes back from PostgreSQL.

Useful direct checks:

```bash
curl -s https://bitcoin-prediction-game-khaki.vercel.app/api/health | jq .

curl -s -X POST \
  -H 'content-type: application/json' \
  -d '{"direction":"up"}' \
  https://bitcoin-prediction-game-khaki.vercel.app/api/predictions | jq .
```

The second command creates a new anonymous identity unless a cookie jar is used.
That is useful for showing that identity comes from the server, but use a cookie
jar when demonstrating persistence.

## 3. Architecture and ownership

```text
React UI
  -> Next.js route wrappers
  -> HTTP handlers
  -> game service / settlement sweep
  -> pure domain rules
  -> PostgreSQL

Coinbase -> entry and settlement quotes
cron-job.org -> protected settlement endpoint
```

Keep the explanation focused on responsibility:

- `src/app/Game.tsx` renders server state, polls and submits a direction. It has
  no scoring or outcome logic.
- `src/app/api/**/route.ts` contains thin Next.js wrappers.
- `src/server/http/handlers.ts` handles identity, input shape, HTTP errors and
  the two settlement triggers.
- `src/server/game/service.ts` coordinates player state and prediction entry.
- `src/domain/rules.ts` decides whether a quote can settle a prediction.
- `src/server/game/store.ts` owns all game SQL.
- `migrations/001_init.sql` protects persisted invariants.

The database clock is the clock of record. PostgreSQL writes `created_at`, uses
`now()` to select due rows and enforces the same 60-second boundary in a
constraint. That avoids comparing clocks from two machines.

On Vercel there is no interval running in the background. An active player's
state request awaits a bounded sweep. cron-job.org calls the same sweep every 15
minutes when there is no traffic. The optional in-process scheduler remains for
local or container hosting.

## 4. Three code paths to open

### Creating a prediction

Open `submitPrediction` in `src/server/game/service.ts`, then
`createPrediction` in `src/server/game/store.ts` and the partial unique index in
`migrations/001_init.sql`.

The flow is:

1. resolve the signed player cookie;
2. perform a friendly active-prediction pre-check;
3. fetch a live Coinbase quote on the server;
4. reject stale or future-dated entry data;
5. insert the prediction with a database timestamp;
6. let the partial unique index stop a racing second insert.

The point to defend is why both checks exist. The pre-check improves the response
and avoids a provider call. It cannot prevent a race. The index can.

The integration test in `tests/integration/store.test.ts` sends 20 concurrent
creation attempts and expects one row.

### Settling without double-scoring

Open `settlePrediction` in `src/server/game/store.ts`.

```sql
with settled as (
  update predictions
     set status = 'resolved', ...
   where id = $1 and status = 'pending'
  returning player_id, outcome
), scored as (
  update players
     set score = score + ...
    from settled
   where players.id = settled.player_id
)
...
```

The score update depends on the row returned by the status update. If another
request settled the prediction first, `settled` is empty and no score changes.
Both updates are part of one statement, so they commit together.

This is why request polling, cron and the optional container scheduler can call
the same sweep safely. Overlap may waste one provider call, but it cannot award
points twice.

### Deciding whether a quote is usable

Open `decideSettlement` in `src/domain/rules.ts`.

The checks are ordered from “not ready” to “safe to decide”:

1. the database-owned 60-second deadline has passed;
2. a provider quote exists;
3. its timestamp is not implausibly future-dated;
4. it is no more than 30 seconds old;
5. timestamp and trade ID place it after the entry quote;
6. the price differs from the entry price.

Only then does the function return a win or loss. Every other branch returns a
named pending reason. Because the function accepts its clock and quote and has no
I/O, boundary cases are quick to test.

The same important rules also exist as database constraints. That duplication is
intentional: TypeScript gives clear behaviour, while PostgreSQL prevents invalid
state from being stored by any caller.

## 5. Testing and evidence

The standard verification commands are:

```bash
npm run typecheck
npm run lint
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/bpg_test npm test
npm run build
```

The deployed-version pass on 16 October 2026 had 170 passing tests across 10
files. The engineering-review branch later had 176 passing tests across the
same 10 files, including deterministic regressions for concurrent prediction
submission and concurrent first-player creation.

- Unit tests cover the settlement matrix, time boundaries, bad quotes, decimal
  comparison, identity and Coinbase parsing.
- Integration tests use real PostgreSQL for partial indexes, constraints and
  concurrent updates.
- HTTP tests cover cookies, validation, status codes, state recovery and the
  protected cron endpoint.
- `scripts/smoke.mjs` covers the complete HTTP journey in local/container mode.

Two failures are worth understanding because they changed the implementation:

- The first outcome constraint could store an unchanged price as a loss. The
  final version explicitly requires settlement and entry prices to differ.
- The smoke test briefly saw `secondsRemaining: 61` because the handler time was
  captured before PostgreSQL created the row. The view now clamps the display to
  60; the database rule was already correct.

Production checks also recorded two separate paths:

- an active round settled after the 60-second floor through `/api/state`;
- another due round received no state request, then cron-job.org called
  `/api/settle`, Vercel returned 200 and Neon recorded settlement one second
  later.

These checks prove that the current triggers work. They do not turn the
15-minute fallback into an exact-time settlement mechanism.

## 6. Trade-offs to volunteer

- **Idle latency:** with no browser traffic, settlement waits for the next cron
  run. A later quote can change the outcome.
- **Flat market:** equality remains pending indefinitely unless the product adds
  a draw or timeout rule.
- **Anonymous identity:** the signature prevents impersonation, not new account
  creation by clearing cookies.
- **Single price venue:** Coinbase is not a market-wide index.
- **Stored score:** it is auditable from prediction history but not continuously
  reconciled by a separate job.
- **No rate limit:** the pending-row constraint limits state growth per player,
  not request volume.
- **Polling still multiplies with active players:** active rounds poll every
  three seconds. Idle polling is slower and hidden tabs pause, but this is not a
  substitute for measured capacity limits or abuse controls.
- **No creation idempotency key:** a retry receives `409` and current state; it
  does not replay the original successful response.
- **Limited browser automation:** the API and HTTP journey are covered, but a
  focused Playwright suite would add confidence around focus, hydration and
  mobile interaction.

## 7. Likely questions

### Why PostgreSQL instead of keeping everything in application code?

The rules that matter under concurrency map directly to partial indexes,
constraints and a conditional update. Keeping those rules only in a service
would make them dependent on every caller checking correctly.

### Why not use an ORM?

Most operations are small, and the important one is a data-modifying CTE. Raw
SQL keeps that transaction visible. The trade-off is manual mapping and less
help with ordinary CRUD.

### What happens when Coinbase is unavailable?

Entry returns `503` and creates no prediction. Settlement leaves existing rows
pending. Neither path invents a price or changes a score.

### Is the game exactly one minute long?

No. One minute is the earliest valid resolution. Active polling normally
triggers a sweep soon after that. An idle round may wait for the 15-minute cron.

### What would change at higher traffic?

Measure provider traffic, pending volume and settlement latency first. Likely
changes are rate limiting, a dedicated worker, claimed or chunked batches,
metrics and score reconciliation. Display caching already reduces Coinbase calls
without allowing cached prices to decide a round.

### What deserves product clarification?

The exact settlement-price definition and flat-market behaviour. Choosing a
historical price at exactly second 60 is a different product rule and would need
a provider or stored market feed that can support it.

## Closing

A concise ending:

> The project is small, but the rules are enforced in the places that can
> actually protect them. React displays authoritative state, the domain function
> explains when a result is allowed, and PostgreSQL handles the concurrency and
> atomicity. The main compromise is explicit: free serverless hosting can delay
> idle settlement and therefore use a later price.
