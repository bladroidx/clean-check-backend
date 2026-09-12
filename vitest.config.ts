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
        // The process entrypoints: listen + signal handlers. Exercised by /smoke, not unit tests.
        'apps/api/src/server.ts',
        'apps/worker/src/main.ts',
        // Postgres repositories: exercised by the testcontainers suite, which does not run in the
        // unit lane. Counting them here would either lower the bar for everything else or force a
        // database into every `npm test`.
        'packages/core/src/db/pg.ts',
      ],
      // Floors, not goals. identity is highest because it is pure, tiny, and ported from another
      // language -- there is no excuse and every reason. The number is secondary to WHICH arms are
      // covered; see .claude/skills/backend-quality-gate/SKILL.md.
      thresholds: {
        'packages/identity/src/**': { statements: 95, branches: 90, functions: 95, lines: 95 },
        'packages/contract/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        // providers and core carry the parsing rule, the charge matrix and the arm selection --
        // the three places a bug is a lie to a buyer rather than an inconvenience.
        'packages/providers/src/**': { statements: 80, branches: 75, functions: 80, lines: 80 },
        'packages/core/src/**': { statements: 75, branches: 70, functions: 75, lines: 75 },
        'apps/api/src/**': { statements: 60, branches: 60, functions: 60, lines: 60 },
      },
    },
  },
});
