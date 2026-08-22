import { defineConfig } from 'vitest/config';

/** Executable-only adapters are exercised as built child processes by package smoke. */
export const SUBPROCESS_ONLY_COVERAGE_EXCLUSIONS = [
  'src/bin/cli.ts',
  'src/bin/mcp.ts',
  'src/bin/metadata.ts',
  'src/lib/entrypoint.ts',
] as const;

export const V8_COVERAGE_EXCLUSIONS = [
  'src/types/generated/**',
  'src/**/*.d.ts',
  ...SUBPROCESS_ONLY_COVERAGE_EXCLUSIONS,
] as const;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules', 'build'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [...V8_COVERAGE_EXCLUSIONS],
      thresholds: {
        branches: 84,
        functions: 90,
        lines: 89,
        statements: 87,
      },
    },
  },
});
