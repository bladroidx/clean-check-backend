import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RETENTION,
  buildProviders,
  GuardedProvider,
  Metrics,
  PgRepositories,
  assertRetentionPolicy,
  createLogger,
  createPool,
  imei24CredentialsFromEnv,
  runRetention,
  type Imei24Credentials,
  type RetentionPolicy,
} from '@imei-check/core';
import type { Provider } from '@imei-check/providers';
import { pollOrders } from './jobs/poll-orders.js';
import { reconcileBalances, type Log } from './jobs/reconcile-balance.js';
import { detectCatalogueDrift } from './jobs/catalogue-drift.js';
import { beat } from './heartbeat.js';

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

// The same guarded logger as the API: every line is scanned for IMEI-shaped digits (throws outside
// production, redacts in it), and pg errors lose the fields that echo row data.
const logger = createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
});

/**
 * A whole number of ms >= `min`, or refuse to boot. `Number('abc')` is NaN, and a NaN interval
 * makes the loop spin flat out -- hammering the supplier and holding its one-job lock.
 */
function intervalFromEnv(name: string, fallback: number, min = 1_000): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min) {
    logger.error({ var: name }, `${name} must be a whole number of milliseconds >= ${min}`);
    process.exit(1);
  }
  return value;
}

const POLL_INTERVAL_MS = intervalFromEnv('WORKER_POLL_INTERVAL_MS', 30_000);
const BALANCE_RECONCILE_INTERVAL_MS = intervalFromEnv('BALANCE_RECONCILE_INTERVAL_MS', 60 * 60_000);
const CATALOGUE_DRIFT_INTERVAL_MS = intervalFromEnv('CATALOGUE_DRIFT_INTERVAL_MS', 24 * 60 * 60_000);
const RETENTION_INTERVAL_MS = intervalFromEnv('RETENTION_INTERVAL_MS', 24 * 60 * 60_000);
/** A run that could not reach the supplier (lock busy, list unreadable) retries this soon. */
const INCOMPLETE_RETRY_MS = intervalFromEnv('WORKER_INCOMPLETE_RETRY_MS', 5 * 60_000);
/** `/metrics` only, on the internal network (never published). `0` turns it off. */
const WORKER_METRICS_PORT = intervalFromEnv('WORKER_METRICS_PORT', 9464, 0);

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

// Both or neither: half-set credentials are refused, exactly as the API refuses them (R19) --
// silently skipping them would leave orders placed by the API that this worker can never poll.
let imei24: Imei24Credentials | undefined;
try {
  imei24 = imei24CredentialsFromEnv({
    IMEI24_BASE_URL,
    IMEI24_USERNAME: process.env['IMEI24_USERNAME'],
    IMEI24_API_KEY: process.env['IMEI24_API_KEY'],
  });
} catch (error) {
  // The message names the variables only, never a value.
  logger.error(error instanceof Error ? error.message : 'invalid imei24 credentials');
  process.exit(1);
}

// A retention window typo ("18" for "180") would drop live data: refuse to boot instead.
const retention: RetentionPolicy = {
  checksDays: Number(process.env['CHECKS_RETENTION_DAYS'] ?? DEFAULT_RETENTION.checksDays),
  providerCallsDays: Number(process.env['PROVIDER_CALLS_RETENTION_DAYS'] ?? DEFAULT_RETENTION.providerCallsDays),
};
try {
  assertRetentionPolicy(retention);
} catch (error) {
  logger.error(error instanceof Error ? error.message : 'invalid retention policy');
  process.exit(1);
}

const pool = createPool(DATABASE_URL, {
  onError: (error) => logger.error({ err: error }, 'database pool error (connection dropped)'),
});
const repos = new PgRepositories(pool);
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
      isDisabled: (providerId, serviceId) => repos.serviceOverrides.isDisabled(providerId, serviceId),
    }),
);

// The TAC directory loader lives only in apps/api/src/lib/tac.ts (reads TAC_SOURCE_FILE off disk);
// nothing in packages/identity or packages/core loads it from a file, and nothing may depend on
// apps/ (ADR-0006). Until a loader moves into a shared package, the worker keeps this stub -- its
// `coverage` text is deliberately generic rather than claiming a real TAC directory backs it.
const tacDirectory = { lookup: () => undefined, version: 'worker', size: 0, attribution: undefined };

let running = true;

const log: Log = (level, event, message) => logger[level](event, message);

/**
 * Runs `job` every `intervalMs`. A job that returns `{ complete: false }` did not do its job (a
 * supplier was unreachable, its lock was busy) and does not count as a success for the staleness
 * gauge; it -- like a job that threw -- is retried after INCOMPLETE_RETRY_MS rather than a full
 * interval, so one lost lock race at boot does not mean a day without a price check.
 *
 * Only the poll loop writes the container heartbeat: "healthy" means orders are being settled, and
 * a daily retention run succeeding must not paper over a poll loop that has been failing for hours.
 */
async function loop(
  name: string,
  intervalMs: number,
  job: () => Promise<unknown>,
  options: { heartbeat?: boolean } = {},
): Promise<void> {
  while (running) {
    const startedAt = Date.now();
    let nextIn = intervalMs;
    try {
      const result = await job();
      logger.debug({ job: name, result, ms: Date.now() - startedAt }, 'job finished');
      const incomplete =
        result !== null && typeof result === 'object' && (result as { complete?: unknown }).complete === false;
      if (!incomplete) metrics.jobLastSuccess.set({ job: name }, Date.now() / 1000);
      nextIn = incomplete ? Math.min(intervalMs, INCOMPLETE_RETRY_MS) : intervalMs;
      if (options.heartbeat === true) {
        await beat().catch((error: unknown) => logger.warn({ err: error }, 'heartbeat not written'));
      }
    } catch (error) {
      // A failing job must not kill the loop: the next tick is a free retry, and a crashed worker
      // silently stops settling orders that are still awaiting an answer.
      logger.error({ job: name, err: error }, 'job failed');
      nextIn = Math.min(intervalMs, INCOMPLETE_RETRY_MS);
    }
    await sleep(Math.max(1_000, nextIn - (Date.now() - startedAt)));
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

if (WORKER_METRICS_PORT > 0) {
  createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metrics.render().then(
      (body) => res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(body),
      () => res.writeHead(500).end(),
    );
  })
    .on('error', (error) => logger.error({ err: error }, 'worker metrics listener failed'))
    .listen(WORKER_METRICS_PORT);
}

logger.info(
  {
    intervals: {
      POLL_INTERVAL_MS,
      BALANCE_RECONCILE_INTERVAL_MS,
      CATALOGUE_DRIFT_INTERVAL_MS,
      RETENTION_INTERVAL_MS,
    },
    retention,
    metrics_port: WORKER_METRICS_PORT,
    providers: providers.map((p) => p.id),
  },
  'worker started',
);

await Promise.all([
  loop(
    'poll-orders',
    POLL_INTERVAL_MS,
    () =>
      pollOrders({
        repos,
        providers,
        tacDirectory,
        metrics,
        log: (event, message) => logger.info(event, message),
      }),
    { heartbeat: true },
  ),
  loop('reconcile-balance', BALANCE_RECONCILE_INTERVAL_MS, async () => {
    const outcome = await reconcileBalances({ providers, repos, metrics, log });
    // The balance fell faster than our books: the likeliest cause is a reprice, so check prices
    // NOW rather than at the next daily run -- a disabled service stops the overspend, an alert
    // alone does not.
    if (outcome.results.some((r) => r.status === 'drift')) {
      const drift = await detectCatalogueDrift({ providers, repos, metrics, log });
      logger.info({ job: 'catalogue-drift', trigger: 'balance-drift', findings: drift.findings.length }, 'price check after balance drift');
    }
    return outcome;
  }),
  loop('catalogue-drift', CATALOGUE_DRIFT_INTERVAL_MS, () =>
    detectCatalogueDrift({ providers, repos, metrics, log }),
  ),
  loop('retention', RETENTION_INTERVAL_MS, async () => {
    const summary = await runRetention(pool, retention);
    logger.info({ job: 'retention', ...summary }, 'retention run finished');
    return summary;
  }),
]);
