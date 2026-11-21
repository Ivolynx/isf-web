import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/db/migrate.ts'],
    },
    // Load test environment variables before any test file
    setupFiles: ['tests/setup.ts'],
    // Pool: threads — forks requires node in PATH; vmThreads breaks vite-node module resolution
    pool: 'threads',
  },
});
