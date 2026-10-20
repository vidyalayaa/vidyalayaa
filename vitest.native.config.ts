import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/api/**/*.test.ts', 'tests/database/schema.test.ts','tests/database/ownership.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
