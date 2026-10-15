import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '@/server/config';

/**
 * Configuration guard rails. The one that matters most for this assignment:
 * simulated market data must not be able to serve real players by accident.
 */
const BASE_ENV = {
  DATABASE_URL: 'postgresql://localhost/test',
  PLAYER_COOKIE_SECRET: 'a-secret-that-is-definitely-long-enough-1234',
};

describe('loadConfig', () => {
  it('accepts a minimal development environment', () => {
    const config = loadConfig({ ...BASE_ENV, NODE_ENV: 'development' });
    expect(config.priceProvider).toBe('coinbase');
    expect(config.cookieSecure).toBe(false);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ PLAYER_COOKIE_SECRET: BASE_ENV.PLAYER_COOKIE_SECRET })).toThrow(ConfigurationError);
  });

  it('requires a long enough cookie secret', () => {
    expect(() => loadConfig({ ...BASE_ENV, PLAYER_COOKIE_SECRET: 'short' })).toThrow(/at least 32 characters/);
    expect(() => loadConfig({ DATABASE_URL: BASE_ENV.DATABASE_URL })).toThrow(ConfigurationError);
  });

  it('rejects an unknown price provider', () => {
    expect(() => loadConfig({ ...BASE_ENV, PRICE_PROVIDER: 'binance' })).toThrow(/must be "coinbase" or "simulated"/);
  });

  it('refuses to serve simulated prices in production by default', () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: 'production', PRICE_PROVIDER: 'simulated' })).toThrow(
      /not allowed when NODE_ENV=production/,
    );
  });

  it('allows simulated prices in production only with an explicit opt-in', () => {
    const config = loadConfig({
      ...BASE_ENV,
      NODE_ENV: 'production',
      PRICE_PROVIDER: 'simulated',
      ALLOW_SIMULATED_PRICES: 'true',
    });
    expect(config.priceProvider).toBe('simulated');
  });

  it('defaults to secure cookies in production and allows an override', () => {
    expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'production' }).cookieSecure).toBe(true);
    expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });

  it('validates the cookie SameSite policy', () => {
    expect(() => loadConfig({ ...BASE_ENV, COOKIE_SAME_SITE: 'Sometimes' })).toThrow(/Lax, Strict, None/);
    expect(loadConfig({ ...BASE_ENV, COOKIE_SAME_SITE: 'None', COOKIE_SECURE: 'true' }).cookieSameSite).toBe('None');
  });

  it('refuses SameSite=None without Secure in production', () => {
    // Browsers reject SameSite=None without Secure, so this would produce a
    // cookie that is silently never stored.
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        COOKIE_SAME_SITE: 'None',
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/requires COOKIE_SECURE=true/);
  });

  it('leaves the external settlement secret unset unless provided', () => {
    expect(loadConfig({ ...BASE_ENV }).settlementSecret).toBeNull();
    expect(loadConfig({ ...BASE_ENV, SETTLEMENT_SECRET: 'trigger-me' }).settlementSecret).toBe('trigger-me');
  });
});
