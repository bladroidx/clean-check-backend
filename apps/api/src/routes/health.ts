import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/**
 * Liveness and readiness.
 *
 * `/readyz` deliberately does NOT consider provider health. A supplier outage is a `SectionResult`,
 * not an outage of this service -- wiring it into readiness makes the orchestrator restart healthy
 * pods during somebody else's incident. Readiness fails on our own dependencies only.
 */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/healthz', { schema: { tags: ['meta'] } }, async () => ({ status: 'ok' }));

  app.get('/readyz', { schema: { tags: ['meta'] } }, async (_request, reply) => {
    const checks: Record<string, string> = {};

    checks.tac_directory = app.tacDirectory.size > 0 ? 'ok' : 'empty';
    // Once Postgres is wired: database reachable, migrations not behind. Nothing else.

    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
};
