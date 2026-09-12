import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createLogger } from './lib/log.js';
import { loadTacDirectory } from './lib/tac.js';
import { Metrics } from '@imei-check/core';
import { MemoryRepositories } from '@imei-check/core';
import { PgRepositories, createPool } from '@imei-check/core';
import { buildProviders, feedbackUrlFor } from './providers/build.js';
import { buildServices } from './services.js';
import type { Repositories } from '@imei-check/core';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });

const tacDirectory = loadTacDirectory(config.TAC_SOURCE_FILE);
logger.info(
  { entries: tacDirectory.size, version: tacDirectory.version },
  'TAC directory loaded',
);

/**
 * Without a database we run the free offline tier only.
 *
 * That is a real, supported mode (milestone M0) rather than a broken one, so it is stated in the
 * log at startup and not disguised: the paid routes are simply absent, and a caller gets a 404
 * rather than a 500 that suggests we tried and failed.
 */
const repos: Repositories | undefined =
  config.DATABASE_URL !== undefined
    ? new PgRepositories(
        createPool(config.DATABASE_URL, {
          // Logged, never fatal: a database failover must not become an API outage.
          onError: (error) => logger.error({ err: error }, 'database pool error (connection dropped)'),
        }),
      )
    : undefined;

const metrics = new Metrics();
const built = buildProviders(config);

for (const skipped of built.skipped) {
  logger.warn({ provider: skipped.providerId, reason: skipped.reason }, 'provider not configured');
}

const services =
  repos !== undefined
    ? buildServices({
        repos,
        providers: built.providers,
        metrics,
        pepper: Buffer.from(config.SERVER_PEPPER, 'utf8'),
        feedbackUrlFor: (providerId) => feedbackUrlFor(config, providerId),
      })
    : undefined;

logger.info(
  {
    mode: services === undefined ? 'free_tier_only' : 'full',
    providers: built.providers.map((p) => p.id),
    catalogue_services: built.catalogue.length,
  },
  services === undefined
    ? 'no DATABASE_URL: serving the free offline tier only'
    : 'paid path enabled',
);

const app = await buildApp({
  logger,
  tacDirectory,
  ...(services !== undefined ? { services } : {}),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => repos?.close())
      .then(() => process.exit(0));
  });
}

// Referenced so an unused import cannot silently drop the in-memory path from the build graph;
// it is the implementation the whole unit suite runs against.
void MemoryRepositories;

await app.listen({ port: config.PORT, host: config.HOST });
