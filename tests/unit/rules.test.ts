import { describe, expect, it } from 'vitest';
import {
  RULES,
  deadlineFor,
  decideSettlement,
  describePendingReason,
  evaluateEntryQuote,
  outcomeFor,
  scoreDeltaFor,
  type SettlementInput,
} from '@/domain/rules';
import type { Direction, Quote } from '@/domain/types';

const T0 = new Date('2026-10-15T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function quote(price: string, offsetMs: number, tradeId: number | null = 1_000_000): Quote {
  return { price, at: at(offsetMs), tradeId, source: 'test' };
}

function input(overrides: Partial<SettlementInput> & { direction?: Direction } = {}): SettlementInput {
  return {
    direction: 'up',
    entryPrice: '80000.00',
    entryPriceAt: at(0),
    entryTradeId: 1_000_000,
    createdAt: at(0),
    quote: quote('80100.00', 61_000, 1_000_100),
    now: at(61_000),
    ...overrides,
  };
}

describe('evaluateEntryQuote', () => {
  it('accepts a fresh quote', () => {
    expect(evaluateEntryQuote(quote('80000.00', 0), at(500))).toEqual({ ok: true });
  });

  it('rejects a quote older than the entry freshness budget', () => {
    const stale = quote('80000.00', -RULES.entryQuoteMaxAgeMs - 1);
    expect(evaluateEntryQuote(stale, at(0))).toEqual({ ok: false, reason: 'stale_quote' });
  });

  it('rejects a quote timestamped implausibly far in the future', () => {
    const future = quote('80000.00', RULES.quoteMaxFutureSkewMs + 1);
    expect(evaluateEntryQuote(future, at(0))).toEqual({ ok: false, reason: 'quote_from_future' });
  });

  it('tolerates a small clock drift between us and the provider', () => {
    const slightlyAhead = quote('80000.00', 2_000);
    expect(evaluateEntryQuote(slightlyAhead, at(0))).toEqual({ ok: true });
  });
});

describe('decideSettlement — waiting period (business rule 6)', () => {
  it('stays pending before 60 seconds have elapsed', () => {
    const decision = decideSettlement(
      input({ now: at(RULES.minWaitMs - 1), quote: quote('80100.00', RULES.minWaitMs - 1) }),
    );
    expect(decision).toEqual({ kind: 'pending', reason: 'too_early' });
  });

  it('stays pending at 59.9 seconds even if the price has already moved', () => {
    const decision = decideSettlement(
      input({ now: at(59_900), quote: quote('81000.00', 59_900, 1_000_099) }),
    );
    expect(decision.kind).toBe('pending');
  });

  it('settles at exactly the 60 second boundary', () => {
    const decision = decideSettlement(
      input({ now: at(60_000), quote: quote('80100.00', 60_000, 1_000_100) }),
    );
    expect(decision).toMatchObject({ kind: 'settle', outcome: 'win', settlementPrice: '80100.00' });
  });

  it('computes the deadline from creation time', () => {
    expect(deadlineFor(T0).toISOString()).toBe('2026-10-15T12:01:00.000Z');
  });

  it('checks the waiting period before consulting the quote at all', () => {
    // A provider outage during the countdown must not change the reported state.
    const decision = decideSettlement(input({ now: at(30_000), quote: null }));
    expect(decision).toEqual({ kind: 'pending', reason: 'too_early' });
  });
});

describe('decideSettlement — scoring (rules 7 and 8)', () => {
  it('UP wins when the price increases', () => {
    const decision = decideSettlement(
      input({ direction: 'up', quote: quote('80000.01', 61_000, 1_000_100) }),
    );
    expect(decision).toMatchObject({ kind: 'settle', outcome: 'win' });
  });

  it('UP loses when the price decreases', () => {
    const decision = decideSettlement(
      input({ direction: 'up', quote: quote('79999.99', 61_000, 1_000_100) }),
    );
    expect(decision).toMatchObject({ kind: 'settle', outcome: 'loss' });
  });

  it('DOWN wins when the price decreases', () => {
    const decision = decideSettlement(
      input({ direction: 'down', quote: quote('79999.99', 61_000, 1_000_100) }),
    );
    expect(decision).toMatchObject({ kind: 'settle', outcome: 'win' });
  });

  it('DOWN loses when the price increases', () => {
    const decision = decideSettlement(
      input({ direction: 'down', quote: quote('80000.01', 61_000, 1_000_100) }),
    );
    expect(decision).toMatchObject({ kind: 'settle', outcome: 'loss' });
  });

  it('detects movement far below one cent', () => {
    const decision = decideSettlement(
      input({ quote: quote('80000.00000001', 61_000, 1_000_100) }),
    );
    expect(decision).toMatchObject({ kind: 'settle', outcome: 'win' });
  });

  it('maps outcomes to score deltas', () => {
    expect(scoreDeltaFor('win')).toBe(1);
    expect(scoreDeltaFor('loss')).toBe(-1);
  });

  it('refuses to derive an outcome for an unchanged price', () => {
    expect(() => outcomeFor('up', 0)).toThrow(/Unchanged prices/);
  });
});

describe('decideSettlement — unchanged price (rule 6b)', () => {
  it('stays pending when the price is identical', () => {
    const decision = decideSettlement(
      input({ quote: quote('80000.00', 61_000, 1_000_100) }),
    );
    expect(decision).toEqual({ kind: 'pending', reason: 'price_unchanged' });
  });

  it('stays pending for as long as the price does not move', () => {
    // Ten minutes later, still no movement: still not a result.
    const decision = decideSettlement(
      input({ quote: quote('80000.00', 600_000, 1_000_900), now: at(600_000) }),
    );
    expect(decision).toEqual({ kind: 'pending', reason: 'price_unchanged' });
  });

  it('treats a numerically equal price with different scale as unchanged', () => {
    const decision = decideSettlement(input({ quote: quote('80000.00000000', 61_000, 1_000_100) }));
    expect(decision).toEqual({ kind: 'pending', reason: 'price_unchanged' });
  });

  it('settles on the first later quote that has moved', () => {
    const stillSame = decideSettlement(input({ quote: quote('80000.00', 62_000, 1_000_101), now: at(62_000) }));
    expect(stillSame.kind).toBe('pending');

    const moved = decideSettlement(input({ quote: quote('80000.50', 63_000, 1_000_102), now: at(63_000) }));
    expect(moved).toMatchObject({ kind: 'settle', outcome: 'win' });
  });
});

describe('decideSettlement — quote ordering and freshness', () => {
  // Note on reachability: with the current constants this timestamp guard is
  // unreachable in production. A quote must be within
  // RULES.settlementQuoteMaxAgeMs (30s) of `now`, while the deadline is 60s
  // after creation and the entry quote is at most a few seconds after creation
  // — so any quote that passes the freshness check is necessarily newer than
  // the entry quote. The guard is kept as defence in depth in case those
  // constants are ever retuned, and because this is a pure function that must
  // stay safe for inconsistent input. The trade-id guard below *is* reachable.
  it('refuses an inconsistent quote that is not strictly later than the entry quote', () => {
    const decision = decideSettlement(
      input({
        now: at(60_000),
        // Entry quote timestamped after the "latest" quote — impossible via the
        // service layer, but the function must not invent a result.
        entryPriceAt: at(31_000),
        quote: quote('80100.00', 30_000, 1_000_100),
      }),
    );
    expect(decision).toEqual({ kind: 'pending', reason: 'quote_not_after_entry' });
  });

  it('refuses a replayed payload whose trade id has not advanced', () => {
    // A cache serving an older payload with a newer-looking timestamp.
    const decision = decideSettlement(
      input({ quote: quote('80100.00', 61_000, 1_000_000) }),
    );
    expect(decision).toEqual({ kind: 'pending', reason: 'quote_not_after_entry' });
  });

  it('falls back to timestamp comparison when no trade id is available', () => {
    const decision = decideSettlement(
      input({
        entryTradeId: null,
        quote: quote('80100.00', 61_000, null),
      }),
    );
    expect(decision.kind).toBe('settle');
  });

  it('refuses to settle on a stale quote', () => {
    const decision = decideSettlement(
      input({
        now: at(200_000),
        quote: quote('80100.00', 200_000 - RULES.settlementQuoteMaxAgeMs - 1, 1_000_100),
      }),
    );
    expect(decision).toEqual({ kind: 'pending', reason: 'stale_quote' });
  });

  it('refuses to settle on a quote from the future', () => {
    const decision = decideSettlement(
      input({
        now: at(61_000),
        quote: quote('80100.00', 61_000 + RULES.quoteMaxFutureSkewMs + 1, 1_000_100),
      }),
    );
    expect(decision).toEqual({ kind: 'pending', reason: 'quote_from_future' });
  });
});

describe('decideSettlement — provider failure (risk: fabricated outcomes)', () => {
  it('stays pending when the provider is unavailable', () => {
    const decision = decideSettlement(input({ quote: null }));
    expect(decision).toEqual({ kind: 'pending', reason: 'provider_unavailable' });
  });

  it('never settles without a quote, at any time after the deadline', () => {
    for (const offset of [60_000, 120_000, 86_400_000]) {
      const decision = decideSettlement(input({ quote: null, now: at(offset) }));
      expect(decision).toEqual({ kind: 'pending', reason: 'provider_unavailable' });
    }
  });
});

describe('describePendingReason', () => {
  it('explains every pending reason to the player', () => {
    const reasons = [
      'too_early',
      'quote_not_after_entry',
      'price_unchanged',
      'stale_quote',
      'quote_from_future',
      'provider_unavailable',
    ] as const;
    for (const reason of reasons) {
      expect(describePendingReason(reason).length).toBeGreaterThan(10);
    }
  });
});
