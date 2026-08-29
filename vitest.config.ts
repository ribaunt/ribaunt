import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup-env.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/solver-worker.ts', 'src/wasm/**'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        statements: 89,
        branches: 85,
        functions: 90,
        lines: 90,
        perFile: false,
      },
    },
  },
});
