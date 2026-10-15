import { describe, expect, it } from 'vitest';
import { compareDecimal, decimalsEqual, formatUsd, isPositiveDecimal, trimDecimal } from '@/domain/decimal';

describe('compareDecimal', () => {
  it('orders prices that differ only in the last decimal place', () => {
    // The reason this module exists: these two values are distinct, and a
    // float comparison of the raw provider strings is not what decides points.
    expect(compareDecimal('82190.33000000', '82190.33000001')).toBe(-1);
    expect(compareDecimal('0.1', '0.10000001')).toBe(-1);
  });

  it('treats different representations of the same value as equal', () => {
    expect(compareDecimal('82190.33', '82190.33000000')).toBe(0);
    expect(compareDecimal('82190', '82190.0')).toBe(0);
  });

  it('handles values whose float representation would collide', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754; the provider strings below
    // are a genuine tie and must compare equal.
    expect(compareDecimal('0.30000000000000004', '0.3')).toBe(1);
    expect(decimalsEqual('0.3', '0.30')).toBe(true);
  });

  it('compares large integers without precision loss', () => {
    expect(compareDecimal('900719925474099.10', '900719925474099.09')).toBe(1);
  });

  it('rejects malformed input rather than guessing', () => {
    expect(() => compareDecimal('82,190.33', '1')).toThrow();
    expect(() => compareDecimal('NaN', '1')).toThrow();
    expect(() => compareDecimal('-1', '1')).toThrow();
    expect(() => compareDecimal('1e5', '1')).toThrow();
  });
});

describe('isPositiveDecimal', () => {
  it.each([
    ['82190.33', true],
    ['0.00000001', true],
    ['0', false],
    ['0.000', false],
    ['', false],
    ['abc', false],
    ['-5', false],
  ])('%s -> %s', (input, expected) => {
    expect(isPositiveDecimal(input)).toBe(expected);
  });
});

describe('trimDecimal', () => {
  it('normalises the scale Postgres returns for NUMERIC(18,8)', () => {
    expect(trimDecimal('80000.00000000')).toBe('80000.00');
    expect(trimDecimal('80025.50000000')).toBe('80025.50');
  });

  it('keeps precision that is significant', () => {
    expect(trimDecimal('80000.12345678')).toBe('80000.12345678');
  });

  it('pads a value with no fractional part', () => {
    expect(trimDecimal('82000')).toBe('82000.00');
  });
});

describe('formatUsd', () => {
  it('formats a price for display', () => {
    expect(formatUsd('82190.33')).toBe('$82,190.33');
    expect(formatUsd('82190.33000000')).toBe('$82,190.33');
  });
});
