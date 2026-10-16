/**
 * Runtime configuration, read from the environment.
 *
 * Deliberately lazy: nothing here is evaluated at module load, so `next build`
 * (which imports route modules) does not require a database or secrets to be
 * present at build time. Values are validated on first use instead.
 */

export type PriceProviderKind = 'coinbase' | 'simulated';

export interface AppConfig {
  nodeEnv: string;
  databaseUrl: string;
  databaseSsl: boolean;
  playerCookieSecret: string;
  cookieSecure: boolean;
  cookieSameSite: 'Lax' | 'Strict' | 'None';
  priceProvider: PriceProviderKind;
  coinbaseApiBase: string;
  priceFetchTimeoutMs: number;
  settlementSchedulerEnabled: boolean;
  settlementIntervalMs: number;
  settlementSecret: string | null;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const MIN_SECRET_LENGTH = 32;

/** A plain environment bag, so tests can pass literals. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: EnvSource = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigurationError('DATABASE_URL is required.');
  }

  const playerCookieSecret = env.PLAYER_COOKIE_SECRET;
  if (!playerCookieSecret || playerCookieSecret.length < MIN_SECRET_LENGTH) {
    throw new ConfigurationError(
      `PLAYER_COOKIE_SECRET is required and must be at least ${MIN_SECRET_LENGTH} characters. ` +
        'Generate one with: openssl rand -base64 48',
    );
  }

  const cookieSecure = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction;

  const cookieSameSite = (env.COOKIE_SAME_SITE ?? 'Lax') as 'Lax' | 'Strict' | 'None';
  if (!['Lax', 'Strict', 'None'].includes(cookieSameSite)) {
    throw new ConfigurationError('COOKIE_SAME_SITE must be one of: Lax, Strict, None.');
  }
  if (cookieSameSite === 'None' && !cookieSecure && isProduction) {
    throw new ConfigurationError(
      'COOKIE_SAME_SITE=None requires COOKIE_SECURE=true; browsers reject the cookie otherwise.',
    );
  }

  const priceProvider = (env.PRICE_PROVIDER ?? 'coinbase') as PriceProviderKind;
  if (priceProvider !== 'coinbase' && priceProvider !== 'simulated') {
    throw new ConfigurationError(`PRICE_PROVIDER must be "coinbase" or "simulated", got "${priceProvider}".`);
  }

  // Requirement: simulated market data must never be able to serve real players.
  // Enabling it in production requires an explicit, deliberate opt-in.
  const allowSimulated = env.ALLOW_SIMULATED_PRICES === 'true';
  if (isProduction && priceProvider === 'simulated' && !allowSimulated) {
    throw new ConfigurationError(
      'PRICE_PROVIDER=simulated is not allowed when NODE_ENV=production. ' +
        'Set ALLOW_SIMULATED_PRICES=true only if you are intentionally running a demo deployment.',
    );
  }

  return {
    nodeEnv,
    databaseUrl,
    databaseSsl: env.DATABASE_SSL === 'true',
    playerCookieSecret,
    // Secure cookies by default in production; overridable so a plain-HTTP
    // preview can still hand out a session cookie.
    cookieSecure,
    // 'Lax' is the right default: the game is a top-level page and the API is
    // same-origin. 'None' exists only for deployments that embed the app in an
    // iframe on another site, where Lax cookies are treated as third-party and
    // dropped. It requires Secure.
    cookieSameSite,
    priceProvider,
    coinbaseApiBase: env.COINBASE_API_BASE ?? 'https://api.exchange.coinbase.com',
    priceFetchTimeoutMs: Number(env.PRICE_FETCH_TIMEOUT_MS ?? 4000),
    settlementSchedulerEnabled: env.VERCEL !== '1' && env.SETTLEMENT_SCHEDULER_ENABLED !== 'false',
    settlementIntervalMs: Number(env.SETTLEMENT_INTERVAL_MS ?? 5000),
    settlementSecret: env.SETTLEMENT_SECRET && env.SETTLEMENT_SECRET.length > 0 ? env.SETTLEMENT_SECRET : null,
  };
}

let cached: AppConfig | undefined;

/** Config is read once per process and reused. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

