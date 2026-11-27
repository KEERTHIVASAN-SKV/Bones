import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The coordinator imports the kernel through an alias, like the apps do (no package publishing).
    alias: { '@bones/kernel': path.resolve(import.meta.dirname, '../kernel/src/index.ts') },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/**/*.ts'],
    },
  },
});
