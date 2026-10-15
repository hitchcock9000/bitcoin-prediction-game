import { Pool } from 'pg';
import { getConfig } from '../config';

/**
 * A single connection pool per process. Next.js dev mode re-evaluates modules
 * on hot reload, so the pool is cached on globalThis to avoid leaking
 * connections during development.
 */
const globalForPool = globalThis as unknown as { __bpgPool?: Pool };

export function getPool(): Pool {
  if (!globalForPool.__bpgPool) {
    const config = getConfig();
    const pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // An idle client erroring (e.g. a database restart) must not crash the
    // process; the pool discards the client and the next query reconnects.
    pool.on('error', (error) => {
      console.error('[db] idle client error:', error.message);
    });
    globalForPool.__bpgPool = pool;
  }
  return globalForPool.__bpgPool;
}

export async function closePool(): Promise<void> {
  const pool = globalForPool.__bpgPool;
  if (pool) {
    globalForPool.__bpgPool = undefined;
    await pool.end();
  }
}
