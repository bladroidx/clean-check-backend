import pino from 'pino';
import { Metrics, PgRepositories, createPool } from '@imei-check/core';
import { pollOrders } from './jobs/poll-orders.js';
import { deliverWebhooks } from './jobs/deliver-webhooks.js';
import { reconcile } from './jobs/reconcile.js';

/**
 * The worker loop.
 *
 * Separate process from the API for one reason that matters operationally: a poll storm or a slow
 * webhook receiver must not consume the connection pool that paid checks need. The two have very
 * different latency requirements and they should fail independently.
 *
 * Every job is idempotent and every job claims its rows with `FOR UPDATE SKIP LOCKED`, so running
 * two workers is safe and is the intended way to scale this.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const POLL_INTERVAL_MS = Number(process.env['WORKER_POLL_INTERVAL_MS'] ?? 30_000);
const WEBHOOK_INTERVAL_MS = Number(process.env['WORKER_WEBHOOK_INTERVAL_MS'] ?? 15_000);
const RECONCILE_INTERVAL_MS = Number(process.env['WORKER_RECONCILE_INTERVAL_MS'] ?? 6 * 60 * 60 * 1000);

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

if (DATABASE_URL === undefined) {
  logger.error('DATABASE_URL is required for the worker; the free tier needs no worker at all');
  process.exit(1);
}

const repos = new PgRepositories(
  createPool(DATABASE_URL, {
    onError: (error) => logger.error({ err: error }, 'database pool error (connection dropped)'),
  }),
);
const metrics = new Metrics();

// Providers are not built here yet: the worker only polls suppliers it was configured for, and a
// worker with no providers still does useful work (webhooks, reconciliation, cache purging).
const providers: [] = [];

let running = true;

async function loop(name: string, intervalMs: number, job: () => Promise<unknown>): Promise<void> {
  while (running) {
    const startedAt = Date.now();
    try {
      const result = await job();
      logger.debug({ job: name, result, ms: Date.now() - startedAt }, 'job finished');
    } catch (error) {
      // A failing job must not kill the loop: the next tick is a free retry, and a crashed worker
      // silently stops settling orders that tenants have already been charged for.
      logger.error({ job: name, err: error }, 'job failed');
    }
    await sleep(Math.max(1_000, intervalMs - (Date.now() - startedAt)));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'worker shutting down');
    running = false;
    void repos.close().then(() => process.exit(0));
  });
}

logger.info({ intervals: { POLL_INTERVAL_MS, WEBHOOK_INTERVAL_MS, RECONCILE_INTERVAL_MS } }, 'worker started');

await Promise.all([
  loop('poll-orders', POLL_INTERVAL_MS, () =>
    pollOrders({
      repos,
      providers,
      tacDirectory: { lookup: () => undefined, version: 'worker', size: 0, attribution: undefined },
      metrics,
      log: (event, message) => logger.info(event, message),
    }),
  ),
  loop('deliver-webhooks', WEBHOOK_INTERVAL_MS, () =>
    deliverWebhooks({ repos, log: (event, message) => logger.info(event, message) }),
  ),
  loop('reconcile', RECONCILE_INTERVAL_MS, () =>
    reconcile({
      repos,
      providers,
      metrics,
      tenantIds: [],
      log: (event, message) => logger.warn(event, message),
    }),
  ),
]);
