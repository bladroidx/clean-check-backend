import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        // Re-export barrels: no logic to cover, and a barrel at 0% drags the number without
        // telling you anything.
        '**/src/index.ts',
        // A build script, not shipped code.
        'packages/contract/src/emit-schema.ts',
        // The process entrypoint: listen + signal handlers. Exercised by /smoke, not by unit tests.
        'apps/api/src/server.ts',
      ],
      // Floors, not goals. identity is highest because it is pure, tiny, and ported from another
      // language -- there is no excuse and every reason. The number is secondary to WHICH arms are
      // covered; see .claude/skills/backend-quality-gate/SKILL.md.
      thresholds: {
        'packages/identity/src/**': { statements: 95, branches: 90, functions: 95, lines: 95 },
        'packages/contract/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'apps/api/src/**': { statements: 85, branches: 80, functions: 85, lines: 85 },
      },
    },
  },
});
