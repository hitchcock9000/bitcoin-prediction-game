# Instructions for AI coding agents

Short and actionable. Read this before changing code.

## What this project is

A one-minute BTC/USD prediction game. A player predicts UP or DOWN, and one
minute later the server decides whether they were right and moves their score by
one point. The whole point of the exercise is that the **server** owns every
decision and that the game rules hold under refresh, retry, concurrency, provider
failure and restarts.

## Architecture boundaries (do not blur these)

```
src/domain/            Pure rules. No database, no network, no clock, no imports
                       from src/server. `decideSettlement` is the whole policy.
src/server/game/       Service boundary + ALL SQL (store.ts). Only place that
                       talks to Postgres.
src/server/prices/     Market data adapters. `coinbase.ts` is production;
                       `simulated.ts` is dev/demo only.
src/server/settlement/ Stateless sweep + in-process scheduler.
src/server/http/       Thin handlers: identity, input shape, error mapping.
                       No business rules.
src/app/api/**/        Two-line wrappers. Keep them that way.
src/app/Game.tsx       UI. Renders state; decides nothing. Never score, never
                       derive an outcome, never trust the local clock.
src/shared/api.ts      HTTP contract types, importable from the browser.
migrations/*.sql       Schema. Migrations are immutable once applied anywhere.
```

If you are about to put a rule in a route handler or in the UI, stop and put it
in `src/domain` or `src/server/game` instead.

## Business invariants (do not weaken)

1. One pending prediction per player — **partial unique index**, not just a check.
2. No resolution before 60 seconds — checked in code **and** by a `CHECK`.
3. A settlement quote must be strictly newer than the entry quote.
4. The price must have **changed**; unchanged is never a win and never a loss.
5. Correct = +1, incorrect = −1, applied in the **same statement** as the status
   change, gated by `WHERE status = 'pending'`.
6. The client never supplies a player id, price, timestamp or score.
7. The database clock is the clock of record for the 60-second rule. The UI
   countdown is decoration.
8. When in doubt, stay pending and report why. Never fabricate an outcome.

Weakening any of these is a product bug, not a refactor.

## Commands

```bash
npm run dev            # development server
npm run build          # production build (standalone)
npm run standalone:prepare  # make .next/standalone runnable
npm start              # run the build (next start)
npm run typecheck      # tsc --noEmit      — must pass
npm run lint           # eslint            — must pass with 0 warnings
npm test               # vitest (unit + integration; needs PostgreSQL)
npm run test:unit      # fast, no database
npm run ci             # typecheck + lint + tests + build
npm run db:migrate     # apply migrations (idempotent)
node scripts/smoke.mjs # end-to-end check against a running server (~70s)
```

Integration tests need a real PostgreSQL (`TEST_DATABASE_URL`). They are not
skipped when it is missing — a failing suite is better than a green lie.

## Conventions

- TypeScript strict. Prices are **exact decimal strings**, never `number`. Use
  `compareDecimal` / `decimalsEqual` from `src/domain/decimal.ts`.
- All SQL in `src/server/game/store.ts`. Parameterised queries only.
- Domain errors (`PredictionAlreadyActiveError`, `PriceUnavailableError`) are
  mapped to status codes in the HTTP layer; never return a bare 500 for a known
  condition.
- Tests: business rules in unit tests with a controllable clock; guarantees that
  live in the database in integration tests against real Postgres. Prefer
  backdating `created_at` over sleeping.
- No new runtime dependency without a stated reason in DECISIONS.md.

## Security

- Never expose `DATABASE_URL`, `PLAYER_COOKIE_SECRET` or `SETTLEMENT_SECRET` to
  the browser. There are no `NEXT_PUBLIC_*` variables in this project; keep it
  that way.
- The player cookie is HttpOnly and HMAC-signed. Verify before trusting.
- `/api/settle` requires `SETTLEMENT_SECRET` and is disabled when unset.
- Never commit `.env`.

## Documentation duties

Update alongside the code, never after the fact:

- `README.md` — user-facing truth: setup, API, rules, limitations.
- `DECISIONS.md` — append a dated entry for each meaningful decision, including
  the alternative rejected and the trade-off. Record experiments with real
  results.
- `WALKTHROUGH.md` — keep it matching the actual implementation.

Do not describe unimplemented behaviour as working. Do not claim a test or a
deployment passed unless it was run and the output was observed.

## Scope

Half-day exercise. No queues, no microservices, no leaderboard, no accounts, no
charting. If a change needs new infrastructure, it needs a DECISIONS.md entry
explaining why the simple version does not work.
