/**
 * Exact decimal helpers for price comparison.
 *
 * The game awards points by comparing two prices. IEEE-754 doubles cannot
 * represent most decimal fractions exactly, so `0.1 + 0.2 !== 0.3`. Comparing
 * prices as doubles would therefore be *approximately* correct, which is not
 * good enough for something that moves a score.
 *
 * Postgres already stores prices as NUMERIC(18,8) and `pg` hands them back as
 * strings, so we never round-trip through a float at all. These helpers compare
 * those strings by scaling both sides to a common number of decimal places and
 * using BigInt.
 */

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

export function isPositiveDecimal(value: string): boolean {
  if (!DECIMAL_PATTERN.test(value)) return false;
  return /[1-9]/.test(value);
}

/**
 * @returns -1 if a < b, 0 if equal, 1 if a > b.
 * @throws if either input is not a plain non-negative decimal string.
 */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const left = scale(a);
  const right = scale(b);
  const width = Math.max(left.fraction.length, right.fraction.length);

  const leftScaled = BigInt(left.integer + left.fraction.padEnd(width, '0'));
  const rightScaled = BigInt(right.integer + right.fraction.padEnd(width, '0'));

  if (leftScaled < rightScaled) return -1;
  if (leftScaled > rightScaled) return 1;
  return 0;
}

export function decimalsEqual(a: string, b: string): boolean {
  return compareDecimal(a, b) === 0;
}

function scale(value: string): { integer: string; fraction: string } {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`Not a valid non-negative decimal string: ${JSON.stringify(value)}`);
  }
  const [integer, fraction = ''] = value.split('.');
  return { integer: integer as string, fraction };
}

/**
 * Trims trailing zeros for display.
 *
 * Postgres returns NUMERIC(18,8) at the *declared* scale, so a price stored as
 * "80000.00" reads back as "80000.00000000". The extra zeros are harmless to
 * correctness — comparisons go through compareDecimal, which normalises scale —
 * but they look like noise in a UI or an audit log, so display paths normalise
 * them here. Full precision is retained when it is significant.
 */
export function trimDecimal(value: string, minFractionDigits = 2): string {
  if (!DECIMAL_PATTERN.test(value)) return value;
  const [integer, fraction = ''] = value.split('.');
  let trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length < minFractionDigits) trimmed = trimmed.padEnd(minFractionDigits, '0');
  return trimmed.length === 0 ? (integer as string) : `${integer}.${trimmed}`;
}

/** Renders a decimal string for humans, e.g. "82190.33" -> "$82,190.33". */
export function formatUsd(value: string, fractionDigits = 2): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return `$${value}`;
  return number.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}
