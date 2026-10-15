import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // Integration tests hit a real Postgres instance, so the default 5s is tight.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    globalSetup: ['tests/global-setup.ts'],
    // Integration test files share one database and truncate between tests, so
    // they must not run concurrently with each other. The suite is small and
    // fast; determinism is worth more than parallel execution here.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      SETTLEMENT_SCHEDULER_ENABLED: 'false',
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
