import Fastify, { type FastifyError } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { InMemoryTacDirectory } from '@imei-check/identity';
import { healthRoutes, type DatabaseProbe } from './routes/health.js';
import { imeiRoutes } from './routes/imei.js';
import { tacRoutes } from './routes/tac.js';
import { checkRoutes } from './routes/checks.js';
import { deepCheckRoutes } from './routes/deep-checks.js';
import { providerFeedbackRoutes } from './routes/provider-feedback.js';
import { adminRoutes } from './routes/admin.js';
import { authPlugin } from './auth/plugin.js';
import { registerRawBody } from './lib/raw-body.js';
import { refreshCircuitGauge, type AppServices } from './services.js';

declare module 'fastify' {
  interface FastifyInstance {
    tacDirectory: InMemoryTacDirectory;
  }
}

export interface AppDeps {
  logger: Logger;
  tacDirectory: InMemoryTacDirectory;
  /**
   * The paid path. Absent means the free offline tier only -- which is a supported mode, not a
   * degraded one: it costs nothing to run and is genuinely useful (milestone M0).
   */
  services?: AppServices;
  /**
   * Readiness probe for Postgres. Absent in the free offline tier, which has no database and must
   * not report a check for one.
   */
  databaseProbe?: DatabaseProbe;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    // Fastify's default id is sequential per-process; a real id survives across replicas.
    genReqId: () => crypto.randomUUID(),
    disableRequestLogging: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('tacDirectory', deps.tacDirectory);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'imei-check',
        description:
          'IMEI reputation API. Every section states what it covers and when it was checked. ' +
          'Absence of a record is not proof that a device is not stolen.',
        version: '1.0.0',
      },
      tags: [
        {
          name: 'free',
          description: 'No supplier calls. Requires an API key when a database is configured.',
        },
        { name: 'paid', description: 'Calls imei24. Costs supplier money; charges callers nothing.' },
        { name: 'meta', description: 'Health, schema and attributions.' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // The generated document at a stable, documented path. "Usable by any app" is a claim that only
  // means something if a client can fetch the schema without knowing which UI plugin we happen to
  // have registered.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    // Never leak an internal message, a provider name or a supplier body to a caller.
    const message =
      status >= 500 ? 'An internal error occurred.' : (error.message ?? 'Bad request.');
    request.log.error({ err: error, status }, 'request failed');
    return reply.code(status).send({
      error: { code: status >= 500 ? 'internal_error' : 'bad_request', message, request_id: request.id },
    });
  });

  await app.register(healthRoutes(deps.databaseProbe));

  if (deps.services !== undefined) {
    const services = deps.services;
    registerRawBody(app);
    await app.register(authPlugin, {
      async lookup(sha256) {
        const key = await services.repos.apiKeys.byHash(sha256);
        if (key === undefined) return undefined;
        const now = new Date();
        // Revoked and expired are checked HERE rather than in the query, so that the reason a key
        // fails is never encoded in a difference the caller can observe.
        if (key.revokedAt !== undefined && key.revokedAt <= now) return undefined;
        if (key.expiresAt !== undefined && key.expiresAt <= now) return undefined;
        const tenant = await services.repos.tenants.byId(key.tenantId);
        return tenant === undefined ? undefined : { tenant, apiKeyId: key.id, scopes: key.scopes };
      },
      onUsed: (id, at) => services.repos.apiKeys.touch(id, at),
    });
    // Lookup is free of charge, but not free of auth: with a database configured, this service
    // has exactly one caller and nothing on it should be reachable without their key. It is also
    // a `checks:write` route like every other check route -- the admin key must not reach it.
    await app.register(async (instance) => {
      instance.addHook('onRequest', instance.requireTenant);
      instance.addHook('onRequest', instance.requireScope('checks:write'));
      await instance.register(imeiRoutes);
      await instance.register(tacRoutes);
    });
    await app.register(checkRoutes(services));
    await app.register(deepCheckRoutes(services));
    await app.register(providerFeedbackRoutes(services));
    await app.register(adminRoutes(services));
    app.get(
      '/metrics',
      { schema: { summary: 'Prometheus metrics.', tags: ['meta'], hide: true } },
      async (_request, reply) => {
        refreshCircuitGauge(services);
        return reply.header('content-type', 'text/plain; version=0.0.4').send(await services.metrics.render());
      },
    );
  } else {
    // No database means no key store to check a caller against -- the free offline tier stays
    // open, as documented (CLAUDE.md, milestone M0).
    await app.register(imeiRoutes);
    await app.register(tacRoutes);
  }

  return app;
}
