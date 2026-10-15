import { migrateTestDatabase, TEST_DATABASE_URL } from './helpers/db';

/**
 * Runs once before the whole suite, so parallel test files cannot race each
 * other applying migrations.
 */
export async function setup(): Promise<void> {
  try {
    await migrateTestDatabase();
  } catch (error) {
    throw new Error(
      `Could not prepare the test database at ${TEST_DATABASE_URL}.\n` +
        'Integration tests need a real PostgreSQL server. See README "Running tests".\n' +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
