/**
 * Types for scripts/migrate.mjs.
 *
 * The migration runner is plain JavaScript so that the CLI, the integration
 * tests and the production container (production dependencies only, no
 * TypeScript) can all share one implementation. This file lets the TypeScript
 * test suite import it with types.
 */
export interface ApplyMigrationsOptions {
  connectionString: string;
  dir?: string;
  ssl?: boolean;
  log?: (message: string) => void;
}

export interface ApplyMigrationsResult {
  applied: string[];
  skipped: string[];
}

export function applyMigrations(options: ApplyMigrationsOptions): Promise<ApplyMigrationsResult>;
