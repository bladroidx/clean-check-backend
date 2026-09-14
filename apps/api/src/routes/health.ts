import type { DatabaseReadiness } from '@imei-check/core';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/**
 * Liveness and readiness.
 *
 * `/readyz` deliberately does NOT consider provider health. A supplier outage is a `SectionResult`,
 * not an outage of this service -- wiring it into readiness makes the orchestrator restart healthy
 * pods during somebody else's incident. Readiness fails on our own dependencies only.
 *
 * Our own dependencies are the TAC directory and, when the paid path is enabled, Postgres. The
 * database is checked for reachability AND for the schema being current, because a deploy that
 * rolled the image forward without the migration reports ready and then fails every paid check --
 * indistinguishable, from outside, from an ordinary incident.
 */

export type DatabaseProbe = () => Promise<DatabaseReadiness>;

export function healthRoutes(probe?: DatabaseProbe): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/healthz', { schema: { tags: ['meta'] } }, async () => ({ status: 'ok' }));

    app.get('/readyz', { schema: { tags: ['meta'] } }, async (_request, reply) => {
      const checks: Record<string, string> = {};

      checks.tac_directory = app.tacDirectory.size > 0 ? 'ok' : 'empty';

      // Absent probe means no DATABASE_URL: the free offline tier, which has no database to be
      // ready for. Reporting a database check there would invent a dependency we do not have.
      if (probe !== undefined) {
        const db = await probe();
        checks.database = db.reachable ? 'ok' : 'unreachable';
        checks.migrations = db.migrationsCurrent ? 'ok' : 'behind';
      }

      const ready = Object.values(checks).every((v) => v === 'ok');
      return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
    });
  };
}
