import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Measure only the kernel's source. Tests and config files must not inflate the number.
      include: ['src/**/*.ts'],
      // types.ts is type declarations only: it has no runtime code to cover.
      exclude: ['src/types.ts', 'node_modules/', 'dist/']
    }
  }
});
