# Engineering walkthrough

## Serverless delivery update — 16 October 2026

The selected hosting is Vercel Hobby, Neon Free and cron-job.org Free.
State requests await the existing settlement sweep before reading results.
The browser polls every three seconds, so active play normally resolves soon
after the minimum wait. The browser never decides the outcome. A protected
15-minute cron sweep is the fallback when no one has the game open. There is
no in-process timer on Vercel. Both triggers use the same domain rules and
atomic PostgreSQL statement, so overlapping executions cannot score twice.

Verified locally on 16 October: 170 tests passed against real PostgreSQL,
including a barrier-controlled request/cron race. Typecheck, lint and production
build passed. The production dependency audit reported zero vulnerabilities.

Delayed settlement uses a later market quote and can change the outcome.
This is a documented zero-cost trade-off, not a claim to settle at exactly
60 seconds. Public deployment and cron execution are still unverified.

Notes for explaining this project to another engineer. Talking points, not a
script. Every claim here is something I can point at in the code or in a command
I actually ran.

Suggested shape for a 20-minute session:

| Time | Section |
| --- | --- |
| 2 min | [Problem and assumptions](#1-problem-and-assumptions-2-minutes) |
| 3 min | [Live demo](#2-live-demo-3-minutes) |
| 5 min | [Architecture and data flow](#3-architecture-and-data-flow-5-minutes) |
| 6 min | [Three critical code paths](#4-three-critical-code-paths-6-minutes) |
| 4 min | [Tests, trade-offs, next steps](#5-tests-trade-offs-next-steps-4-minutes) |

---

## 0. Opening (60 seconds, say it naturally)

> "It's a one-minute prediction game. You see the BTC/USD price and your score,
> you pick higher or lower, and a minute later the server tells you whether you
> were right and moves your score by one point.
>
> The UI is small on purpose. Almost all the effort went into the fact that the
> rules have to hold when things are inconvenient — you refresh, you double-click,
> you close the tab, the price feed goes down, the market doesn't move, the
> server restarts halfway through your round.
>
> So the design rule I kept coming back to is: the browser asks, the server
> decides. The browser never sends a price, never sends a player ID, never
> computes a score, and its clock has no authority.
>
> Concretely that's 160 tests, a schema that enforces the rules as constraints,
> and a settlement loop that runs on a timer in the server process and doesn't
> need your tab open."

---

## 1. Problem and assumptions (2 minutes)

The assignment is short, and a few things genuinely aren't specified. I wrote
down every gap and picked an interpretation. The two that shaped the design most:

**"The price has changed" is a condition of resolution.** So if the price is
exactly the same after 60 seconds, I don't score it. It stays open until a later
quote actually moves. Treating unchanged as a loss would be inventing an outcome,
and the rules explicitly say unchanged isn't a win or a loss. The cost: a
prediction can stay open longer than a minute on a flat market. I think that's
the honest reading, and it's `README.md` assumption A1.

**We need a quote timestamp that isn't ours.** This is the one that surprised me.
"Fair settlement" is not a feature you can bolt on at the end — it depends on
having a market-data source that tells you *when* the price it's giving you was
valid. I checked the obvious endpoints: Coinbase's `/v2/prices/BTC-USD/spot` and
Kraken's ticker both return a price with **no timestamp at all**. If I'd used
either, every timing decision would have rested on my own server clock, and I'd
have had no way to tell a fresh quote from a cached one. Binance was out for a
different reason — it only lists BTCUSDT, and the live call returned
`"Service unavailable from a restricted location"`, which is an outage that
depends on where you deploy.

So: Coinbase Exchange `/products/BTC-USD/ticker`, which gives me a real BTC/USD
pair, a provider `time`, and a monotonic `trade_id`.

Other assumptions are in the README table: whose clock decides 60 seconds (the
database's), what happens if the feed is down (no outcome at all), how identity
works, whether a one-cent move counts (yes).

---

## 2. Live demo (3 minutes)

The thing to show is the loop and the states, not the visuals.

1. **Open the page.** Score 0, live price with its timestamp, two buttons.
   If the deployment is running simulated prices there's a banner saying so
   (see the demo-mode note below).
2. **Click Higher.** The buttons disable immediately and say "Placing…". That
   matters — the player should never be unsure whether a tap registered.
3. **Pending state.** It shows your entry price, the entry time, a countdown, and
   a sentence explaining what it's waiting for. The countdown is just a display:
   it's seeded from the server's `secondsRemaining` on every poll. If I edit the
   system clock, the result doesn't change.
4. **Try to predict again.** Buttons are disabled. If you force a second request
   (curl, or a second tab), you get a 409 and the UI resyncs from the state the
   server returns in the error.
5. **Wait.** Do nothing. Around 60–65 seconds later the result appears, the score
   changes, and the buttons come back.
6. **Refresh.** Score and history are still there — they were never in the client.
7. **Optional, worth doing:** `curl` the API directly and show that the entry
   price comes from the server, not from anything the client sent.

If the deployment is running the simulated feed, say so out loud:
*"The sandbox I built this in can't reach market data APIs, so the preview runs a
simulated feed with a visible banner. The default is Coinbase; the banner exists
so nobody can mistake demo prices for real ones."*

---

## 3. Architecture and data flow (5 minutes)

```
Browser ──HTTP──► Route handlers ──► Game service ──► Domain rules (pure)
                       │                  │                │
                       │                  └──► Coinbase    └── (no I/O at all)
                       │                          (entry)
                       ▼
                  PostgreSQL  ◄──── Settlement sweep ◄──── Scheduler (setInterval)
                  (state + constraints)   │
                                          └──► Coinbase (settlement, one quote per sweep)
```

**The browser** renders and asks. It has no scoring logic and no outcome logic.
The countdown is decoration.

**Route handlers** (`src/server/http/handlers.ts`) do three things: resolve
identity from the signed cookie, check the *shape* of the input, and map domain
errors to status codes. They're plain `Request → Response` functions so they can
be tested without booting a server. There's no rule in them.

**The game service** (`src/server/game/service.ts`) is the ownership boundary —
it fetches the entry quote, refuses an unusable one, and calls the store.

**The domain** (`src/domain/rules.ts`) is pure. `decideSettlement` takes an entry
price, a candidate quote and a `now`, and returns either a concrete outcome or a
named reason to wait. No database, no clock, no network.

**Postgres** holds the state of record *and* enforces invariants independently of
the application: one pending prediction per player, no early resolution, the
outcome has to match the price movement.

**The scheduler** is a `setInterval` in the web process. It calls a stateless
sweep, which discovers its work by querying the database. That's why restarts and
multiple instances are safe — nothing is remembered in memory.

One place where I deviated from the obvious design: **the database clock is the
clock of record.** `created_at` and `resolved_at` come from Postgres, the sweep
selects due rows with `created_at + interval <= now()` in SQL, and it hands the
same `now()` back to the decision function. If I'd compared the app clock against
the DB clock, clock drift between two machines could make a `CHECK` constraint
reject a legitimate settlement — or make the sweep sit idle on work that was
already due.

---

## 4. Three critical code paths (6 minutes)

### a) Creating a prediction — where "only one active prediction" really lives

`src/server/game/store.ts` → `createPrediction`, with
`migrations/001_init.sql`:

```sql
create unique index predictions_one_pending_per_player
  on predictions (player_id) where status = 'pending';
```

The service *does* check for an existing prediction first, but only to return a
friendly error without calling the price API. That check is a race: two requests
can both read "no pending prediction" and both insert.

The index is the guarantee. The second insert fails with a `23505` on that
specific constraint, which becomes a `409` with the current state attached so the
UI can recover. I verified this before writing any application code —
20 truly-parallel inserts, exactly 1 succeeded — and it's now a test
(`tests/integration/store.test.ts`).

### b) Settling — why double-scoring is impossible, not just unlikely

`src/server/game/store.ts` → `settlePrediction`:

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

The score change is *driven by the rows the status update actually returned*. There
is no window between "check the status" and "add a point" where a second request
could fit. Both CTEs are one statement, so they commit together or not at all.

That property is what lets me have three settlement callers — the scheduler, an
opportunistic path, and an external cron hitting `POST /api/settle` — without
worrying about them overlapping. A loser in a race gets `settled: false`, which is
a normal outcome, not an error.

### c) Deciding the rules — one pure function, ordered checks

`src/domain/rules.ts` → `decideSettlement`. The order matters and is deliberate:

1. Has 60 seconds actually passed? (hard floor, checked first so a slow provider
   during the countdown can't influence anything)
2. Is there a quote at all? No quote means no known price — never fabricate one.
3. Is the quote's timestamp sane (not from the future, not stale)?
4. Is it genuinely *newer* than the entry quote? Timestamp, and trade id when
   both sides have one.
5. Has the price actually changed?
6. Only then: score it.

Every early return is a **named reason** (`price_unchanged`,
`provider_unavailable`, `stale_quote`, …) which the UI turns into a sentence.
That's why a waiting player sees "the price hasn't moved yet" instead of a
spinner — the server knows why it's waiting, so it can say.

**One honest detail here.** While writing the tests I worked out that check 4's
timestamp branch is *unreachable* with the current constants: a quote has to be
within 30 seconds of now, the deadline is 60 seconds after creation, and the entry
quote is at most a few seconds after creation — so anything that passes freshness
is necessarily newer than the entry. I kept it as defence-in-depth for retuned
constants, and the test says so explicitly rather than pretending it proves
production behaviour. The **trade-id** guard is reachable, and it fired during
development and caught a bug in my own test fixture, which was a good sign it
isn't decorative.

---

## 5. Tests, trade-offs, next steps (4 minutes)

### What's actually verified

```bash
npm run typecheck   # clean
npm run lint        # 0 errors, 0 warnings
npm test            # 160 tests, 10 files, all passing
npm run build       # production build OK
node scripts/smoke.mjs --expect-simulated   # 14/14 checks
```

- **Unit tests** (no database) cover the rules exhaustively: all four
  win/loss combinations, the exact 60-second boundary, unchanged price, stale and
  future-dated quotes, provider failure, and decimal comparison that a float
  would get wrong.
- **Integration tests** run against **real PostgreSQL**, because the guarantees
  under test *are* database behaviour — a fake would let the suite pass while the
  constraints were broken. They cover 20 concurrent creations (1 wins), 10
  concurrent settlements (score moves once), two racing sweeps, and the schema
  refusing an outcome that contradicts the price movement.
- **HTTP tests** drive the real handlers with real `Request`/`Response` objects:
  cookie issuance, cookie forgery rejection, `409` on duplicates, `503` when the
  feed is down, `404`/`401`/`200` on the protected settle endpoint.
- **The smoke script** runs the whole journey against a running server over HTTP,
  including the part no unit test can prove: a prediction created now is settled
  about a minute later with the score moved exactly once.

Two things I'd point out as evidence of the process rather than the outcome:
the smoke test caught a real bug (`secondsRemaining` briefly reported 61 because
the deadline is anchored to the database clock while `now` is read before the
insert), and writing the constraint tests caught a genuine hole in my first
`CHECK` — it would have allowed an **unchanged** price to be scored as a *loss*,
because `(outcome='win') = (entry > entry)` is `true = false`… which is false, but
`(outcome='loss')` isn't excluded by that biconditional either. The constraint now
requires `settlement_price <> entry_price` as well.

**Restart recovery, demonstrated:** I created a prediction, killed the server
before its window elapsed, waited past the deadline with the process down,
confirmed the row was still `pending` in the database, then restarted. The boot
sweep settled it immediately (`prediction_settled` in the logs), the score moved
once, and the same cookie could play again. Nothing lives in process memory.

### Trade-offs — what I deliberately didn't do

- **No AWS.** Managed Postgres plus one container satisfies every requirement. I
  wasn't going to add IAM, a VPC and a scheduler to a half-day exercise to make a
  diagram look more impressive. The app is portable — `DATABASE_URL` and
  `POST /api/settle` mean App Runner + RDS + EventBridge is a config change, not a
  rewrite.
- **No ORM.** The important query is a data-modifying CTE that updates two tables;
  an ORM would have made it harder to read, not easier.
- **No per-prediction timers.** They die on redeploy and strand the prediction
  silently. A stateless sweep can't lose work.
- **No rate limiting yet.** The unique index bounds the damage (you can't
  accumulate predictions) but not request volume. Listed as a limitation.
- **No leaderboard, accounts, history UI, charts.** Not asked for.

### Limitations I'd volunteer before being asked

1. **Suspension.** On a host that idles containers to zero, ticks don't fire while
   asleep. Predictions settle late — never wrongly, because eligibility is
   computed from stored `created_at`, but late.
2. **Identity is integrity, not authentication.** The signature stops you
   impersonating a specific player; it doesn't stop you clearing your cookie and
   starting fresh. Scores aren't a competitive ranking.
3. **A flat market can hold a prediction open indefinitely.**
4. **Single venue**, not a cross-exchange index.
5. **`players.score` isn't cross-checked against the prediction rows by a
   constraint** (a `CHECK` can't span tables). It's derivable —
   `count(wins) - count(losses)` — so a reconciliation job would be the next step.

### With another day

Rate limiting on prediction creation; a reconciliation job; metrics instead of log
lines (settlement latency, provider error rate, pending count); chunked sweeps and
a dedicated worker once one tick can't clear the due batch; and a product decision
about the flat-market case.

### Scale — the "10,000 players" question

The first thing that breaks isn't the database, it's the price API: N players
polling every 3 seconds is N/3 upstream requests per second. That's already
handled — the displayed price goes through a 2-second TTL cache
(`src/server/prices/cached.ts`), and **entry and settlement prices never come from
it**, because those decide points. That's the one place I was deliberate about
promoting authority rather than letting a cache flag do it.

After that: chunk the sweep by player ID and move settlement to a queue-driven
worker, add per-player rate limits, and read the pending predictions from a
replica if read load matters. None of that is needed at this size.

---

## Likely questions, with grounded answers

**Why this stack?**
Next.js gives me one deployable process: route handlers for the API and React for
the UI, so there's no second service to operate. Postgres because the correctness
story *is* database features — partial unique indexes, `CHECK` constraints, a
conditional update that moves a score atomically. If I'd used SQLite or an ORM
over something simpler, I'd have had to reimplement those guarantees in
application code, which is exactly where they'd be fragile.

**Why not AWS?**
Nothing here needs it. The requirements are a relational database, a process that
stays alive, and an outbound HTTP call. Adding RDS plus App Runner plus a schedule
would take most of the timebox and make no rule more reliable. The design doesn't
block AWS — `POST /api/settle` exists precisely so an external scheduler can drive
settlement instead of my in-process timer.

**What happens when the price doesn't change?**
It stays open. The rule says resolution requires the price to have changed, and
says unchanged is neither a win nor a loss. So the player sees "the price hasn't
moved yet" and we retry each sweep. It's the honest answer, and it's the reason
`decideSettlement` returns a named `price_unchanged` reason rather than a silent
pending state.

**How do you ensure fair settlement?**
Four things, in order of importance. One: entry and settlement prices come from
the same provider, and the recorded entry quote carries the provider's own
timestamp. Two: the settlement quote must be strictly newer than the entry quote
(timestamp and trade id). Three: settlement uses the database clock, so app/DB
drift can't shift the 60-second window. Four: the player never supplies a price —
only a direction. And unchanged or stale quotes aren't settled at all.

**What if the provider goes down?**
Nothing bad happens to your point. If the feed is down at entry, no prediction is
created (503, with a reason). If it's down at settlement, the prediction stays
pending and the sweep retries; the score is untouched. That's `provider_unavailable`
in `decideSettlement`, and it's covered by tests at both levels.

**What if the browser closes?**
Nothing. Settlement is a timer in the server process that reads pending rows from
the database. I verified this by killing the server mid-round and restarting it
after the deadline — it settled on boot.

**What prevents duplicate predictions?**
A partial unique index, not an application check. The service *also* checks, but
that's for a nicer error message; the index is what makes it impossible under
concurrency. Twenty parallel inserts → one row.

**What prevents double scoring?**
The score change is inside the same statement as the status change and is driven
by the rows that statement actually returned. A second attempt matches zero rows
and changes nothing. Ten concurrent settlements → score moves once.

**What would you change in a team?**
I'd want the settlement policy reviewed by someone else before implementation,
because it's the part where a small interpretation difference changes the product
— "unchanged price" especially. And I'd want the schema constraints reviewed,
since they encode business rules in a place people don't usually look. The rest is
ordinary.

**What would you do differently after feedback?**
If someone told me the flat-market behaviour is bad UX, I'd treat that as a
product decision rather than a bug: either add a maximum wait with a documented
"no result" outcome, or make the market data source higher-resolution so a move is
near-certain within a minute. I'd want the decision recorded rather than quietly
changing the scoring.
