-- 001_init.sql
--
-- Game state: players and predictions.
--
-- Two deliberate choices worth explaining to a reviewer:
--
-- 1. Prices are NUMERIC(18,8), never float8. Binary floating point cannot
--    represent 0.1 exactly, and this game awards points by comparing two
--    prices. Exact decimal comparison removes a whole class of "the price
--    looked higher to the UI but not to the server" bugs.
--
-- 2. Several business rules are enforced by the database rather than only by
--    application code. Application checks are necessary but not sufficient:
--    two concurrent requests can both pass a check-then-act sequence. The
--    constraints below hold even if a future caller bypasses the service layer.

create table players (
  id         uuid primary key default gen_random_uuid(),
  score      integer not null default 0,
  created_at timestamptz not null default now(),
  -- Touch-on-read so an operator can spot abandoned players. Not used by the rules.
  last_seen_at timestamptz not null default now()
);

comment on table players is
  'Anonymous players. A row is created on first request; the client never supplies or learns anything but an opaque signed cookie.';

create table predictions (
  id              uuid primary key default gen_random_uuid(),
  player_id       uuid not null references players (id) on delete cascade,
  direction       text not null check (direction in ('up', 'down')),

  -- Entry quote, captured server-side at creation time. The client cannot
  -- supply any of these values.
  entry_price     numeric(18,8) not null check (entry_price > 0),
  entry_price_at  timestamptz not null,
  entry_trade_id  bigint,

  -- Which provider produced the entry quote, so a stored prediction is always
  -- self-describing when debugging a settlement.
  price_source    text not null,

  -- Server-side creation time. This is the clock that governs the 60s wait,
  -- not any client clock.
  created_at      timestamptz not null default now(),

  status          text not null default 'pending' check (status in ('pending', 'resolved')),

  settlement_price    numeric(18,8) check (settlement_price > 0),
  settlement_price_at timestamptz,
  resolved_at         timestamptz,
  outcome             text check (outcome in ('win', 'loss')),

  -- A resolved prediction carries complete settlement data; a pending one
  -- carries none. Prevents half-settled rows that would be impossible to score.
  constraint predictions_settlement_completeness check (
    (status = 'pending'
      and settlement_price is null
      and settlement_price_at is null
      and resolved_at is null
      and outcome is null)
    or
    (status = 'resolved'
      and settlement_price is not null
      and settlement_price_at is not null
      and resolved_at is not null
      and outcome is not null)
  ),

  -- Business rule: no prediction may resolve before 60s have elapsed.
  -- Redundant with the settlement policy in code, but the invariant is too
  -- important to depend on a single code path remembering it.
  constraint predictions_no_early_resolution check (
    status = 'pending'
    or resolved_at >= created_at + interval '60 seconds'
  ),

  -- The settlement quote must genuinely be later than the entry quote.
  constraint predictions_settlement_after_entry_quote check (
    status = 'pending'
    or settlement_price_at > entry_price_at
  ),

  -- The scoring rule itself, as a database invariant. For an UP prediction a
  -- win requires a strictly higher settlement price; for DOWN, strictly lower.
  --
  -- The extra `settlement_price <> entry_price` clause matters: without it the
  -- biconditional alone would permit a resolved row with unchanged prices and
  -- outcome 'loss', because (outcome = 'win') is false and (entry > entry) is
  -- also false. With it, "unchanged" cannot be scored as either outcome. This
  -- is exactly the kind of near-miss the unit tests look for in the pure
  -- decision function, so the database should not be looser than the code.
  constraint predictions_outcome_matches_price_movement check (
    status = 'pending'
    or (
      settlement_price <> entry_price
      and (outcome = 'win') = (
        case direction
          when 'up'   then settlement_price > entry_price
          when 'down' then settlement_price < entry_price
        end
      )
    )
  )
);

comment on table predictions is
  'One row per prediction. Doubles as the score audit log: a player''s score is always count(win) - count(loss) over their resolved rows.';

-- Invariant: at most one pending prediction per player (business rule 4).
-- A partial unique index is the correct tool here. A "SELECT then INSERT"
-- guard in application code would race: two concurrent requests can both see
-- zero pending rows. Here the second INSERT fails with SQLSTATE 23505 and the
-- API turns that into a 409.
create unique index predictions_one_pending_per_player
  on predictions (player_id)
  where status = 'pending';

-- The settlement sweep only ever looks for pending predictions whose wait has
-- elapsed, ordered by age. This partial index is exactly that query.
create index predictions_pending_created_at_idx
  on predictions (created_at)
  where status = 'pending';

-- Player history / score reconciliation.
create index predictions_player_created_at_idx
  on predictions (player_id, created_at desc);
