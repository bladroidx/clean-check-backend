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
import { healthRoutes } from './routes/health.js';
import { imeiRoutes } from './routes/imei.js';
import { tacRoutes } from './routes/tac.js';

declare module 'fastify' {
  interface FastifyInstance {
    tacDirectory: InMemoryTacDirectory;
  }
}

export interface AppDeps {
  logger: Logger;
  tacDirectory: InMemoryTacDirectory;
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
        { name: 'free', description: 'No credits, no upstream providers.' },
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

  await app.register(healthRoutes);
  await app.register(imeiRoutes);
  await app.register(tacRoutes);

  return app;
}
