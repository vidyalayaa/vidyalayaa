import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/security/**/*.test.ts',
      'tests/api/**/*.test.ts',
      'tests/database/**/*.test.ts',
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
