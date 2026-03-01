import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules', 'build'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/types/generated/**', 'src/**/*.d.ts', 'src/index.ts'],
    },
  },
});

