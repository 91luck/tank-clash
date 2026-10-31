import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/tests/**/*.test.ts', 'server/tests/**/*.test.ts', 'client/tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
