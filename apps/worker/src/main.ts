import { fileURLToPath } from 'node:url';
import pino from 'pino';
import {
  buildProviders,
  GuardedProvider,
  Metrics,
  PgRepositories,
  createPool,
  type Imei24Credentials,
} from '@imei-check/core';
import type { Provider } from '@imei-check/providers';
import { pollOrders } from './jobs/poll-orders.js';

/**
 * The worker loop.
 *
 * Separate process from the API for one reason that matters operationally: a poll storm must not
 * consume the connection pool that paid checks need, and the two have very different latency
 * requirements and should fail independently.
 *
 * Every job is idempotent and claims its rows with `FOR UPDATE SKIP LOCKED`, so running two
 * workers is safe and is the intended way to scale this.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const POLL_INTERVAL_MS = Number(process.env['WORKER_POLL_INTERVAL_MS'] ?? 30_000);

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

if (DATABASE_URL === undefined) {
  logger.error('DATABASE_URL is required for the worker; the free tier needs no worker at all');
  process.exit(1);
}

/**
 * Same reasoning as `apps/api/src/config.ts`'s `DEFAULT_CATALOGUE_DIR`: an absolute default is
 * identical whether the process is started from the repo root (Docker) or from `apps/worker`
 * (`npm run dev` under npm workspaces), and a cwd-relative one would not be. Computed relative to
 * THIS file rather than imported from `apps/api`, because nothing depends on `apps/` (ADR-0006).
 */
const DEFAULT_CATALOGUE_DIR = fileURLToPath(
  new URL('../../../packages/providers/catalogue', import.meta.url),
);

const IMEI24_BASE_URL = process.env['IMEI24_BASE_URL'] ?? 'https://pro.imei24.com';
if (!IMEI24_BASE_URL.startsWith('https://')) {
  // Never log the value itself in a way that could be mistaken for approval -- the message names
  // the variable, not the credential, and the base URL carries no secret, but the point of this
  // check is that the request body will (username + API key), so refuse before any call is made.
  logger.error(
    { var: 'IMEI24_BASE_URL' },
    'IMEI24_BASE_URL must be https: the request body carries the API key and the IMEI',
  );
  process.exit(1);
}

const imei24Username = process.env['IMEI24_USERNAME'];
const imei24ApiKey = process.env['IMEI24_API_KEY'];
const imei24: Imei24Credentials | undefined =
  imei24Username !== undefined && imei24ApiKey !== undefined
    ? { baseUrl: IMEI24_BASE_URL, username: imei24Username, apiKey: imei24ApiKey }
    : undefined;

const repos = new PgRepositories(
  createPool(DATABASE_URL, {
    onError: (error) => logger.error({ err: error }, 'database pool error (connection dropped)'),
  }),
);
const metrics = new Metrics();

const built = buildProviders({
  catalogueDir: process.env['PROVIDER_CATALOGUE_DIR'] ?? DEFAULT_CATALOGUE_DIR,
  ...(imei24 !== undefined ? { imei24 } : {}),
});
for (const skip of built.skipped) {
  logger.info({ provider_id: skip.providerId, reason: skip.reason }, 'provider not built');
}

const dailySpendUsd = Number(process.env['IMEI24_DAILY_SPEND_USD'] ?? 10);
// Every built provider gets the same two guards (single-flight, daily spend cap) regardless of
// which supplier it is -- imei24 today, whatever comes next tomorrow. The API applies the same
// wrapper (Task 7/9) so the lock and the spend cap are shared truthfully across both processes.
const providers: readonly Provider[] = built.providers.map(
  (provider) =>
    new GuardedProvider(provider, {
      lock: repos.locks,
      lockWaitMs: 5_000,
      dailySpendUsd,
      costSince: (providerId, since) => repos.providerCalls.costSinceForProvider(providerId, since),
    }),
);

// The TAC directory loader lives only in apps/api/src/lib/tac.ts (reads TAC_SOURCE_FILE off disk);
// nothing in packages/identity or packages/core loads it from a file, and nothing may depend on
// apps/ (ADR-0006). Until a loader moves into a shared package, the worker keeps this stub -- its
// `coverage` text is deliberately generic rather than claiming a real TAC directory backs it.
const tacDirectory = { lookup: () => undefined, version: 'worker', size: 0, attribution: undefined };

let running = true;

async function loop(name: string, intervalMs: number, job: () => Promise<unknown>): Promise<void> {
  while (running) {
    const startedAt = Date.now();
    try {
      const result = await job();
      logger.debug({ job: name, result, ms: Date.now() - startedAt }, 'job finished');
    } catch (error) {
      // A failing job must not kill the loop: the next tick is a free retry, and a crashed worker
      // silently stops settling orders that are still awaiting an answer.
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

logger.info(
  { intervals: { POLL_INTERVAL_MS }, providers: providers.map((p) => p.id) },
  'worker started',
);

await Promise.all([
  loop('poll-orders', POLL_INTERVAL_MS, () =>
    pollOrders({
      repos,
      providers,
      tacDirectory,
      metrics,
      log: (event, message) => logger.info(event, message),
    }),
  ),
]);
