import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All test files share one database, so run them one after another.
    fileParallelism: false,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://cpl:cpl@localhost/cpl_test' },
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
