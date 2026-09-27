#!/usr/bin/env node
/**
 * Lists, or lifts, the services the catalogue drift job switched off
 * (apps/worker/src/jobs/catalogue-drift.ts).
 *
 *   npm run service:override -- list
 *   npm run service:override -- clear <provider_id> <service_id>
 *
 * Lifting is deliberately a human step, and it comes AFTER the catalogue YAML carries the new
 * price and that build is deployed. The spend cap sums the catalogue price: clearing the override
 * while the YAML still says the old price re-arms a cap that under-counts every purchase -- the
 * exact failure the override exists to stop. The next drift run re-disables the service if the
 * price still does not match, so a premature clear costs at most one drift interval of exposure.
 */
import { PgRepositories, createPool } from '@imei-check/core';

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const [command, providerId, serviceId] = process.argv.slice(2);
const repos = new PgRepositories(createPool(DATABASE_URL));

try {
  if (command === 'list') {
    const overrides = await repos.serviceOverrides.list();
    if (overrides.length === 0) console.log('No services are disabled.');
    for (const o of overrides) {
      console.log(
        `${o.providerId} ${o.serviceId}  ${o.reason}  catalogue $${o.cataloguePriceUsd}` +
          `  live ${o.livePriceUsd === undefined ? '(missing)' : `$${o.livePriceUsd}`}` +
          `  since ${o.detectedAt.toISOString()}`,
      );
    }
  } else if (command === 'clear' && providerId !== undefined && serviceId !== undefined) {
    const cleared = await repos.serviceOverrides.clear(providerId, serviceId);
    console.log(cleared ? `Re-enabled ${providerId} ${serviceId}.` : `${providerId} ${serviceId} was not disabled.`);
  } else {
    console.error('usage: service-override.mjs list | clear <provider_id> <service_id>');
    process.exitCode = 1;
  }
} finally {
  await repos.close();
}
