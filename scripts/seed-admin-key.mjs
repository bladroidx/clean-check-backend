#!/usr/bin/env node
/**
 * Mints an admin key holding ONLY `imei:reveal` (ADR-0007) -- never `checks:write`. A key holding
 * both is refused at auth (apps/api/src/auth/plugin.ts), so this script does not accept an option
 * to add `checks:write`: there is no supported way to make that mistake through it.
 *
 * Reuses the existing service tenant (`SEED_TENANT_ID`, default `ten_check_this_phone`) rather
 * than creating a new one -- an admin key is a different credential for the same tenant, not a
 * second customer. `npm run seed:service-tenant` must have run at least once first.
 *
 * Never run this against a production database without checking `SEED_TENANT_ID` first: it prints
 * the plaintext key to stdout, once.
 */
import { PgRepositories, createPool } from '@imei-check/core';
import { generateApiKey } from '../apps/api/dist/auth/keys.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined) {
  console.error('DATABASE_URL is required. Example:');
  console.error(
    '  DATABASE_URL=postgres://imei:imei@localhost:5432/imei_check node scripts/seed-admin-key.mjs',
  );
  process.exit(1);
}

const TENANT_ID = process.env.SEED_TENANT_ID ?? 'ten_check_this_phone';
const live = process.env.SEED_LIVE_KEY === 'true';

const repos = new PgRepositories(createPool(DATABASE_URL));

try {
  const tenant = await repos.tenants.byId(TENANT_ID);
  if (tenant === undefined) {
    console.error(`No tenant '${TENANT_ID}'. Run npm run seed:service-tenant first.`);
    process.exit(1);
  }

  const key = generateApiKey(live);
  await repos.apiKeys.insert({
    id: `key_admin_${Date.now()}`,
    tenantId: TENANT_ID,
    prefix: key.prefix,
    keySha256: key.sha256,
    scopes: ['imei:reveal'],
    revokedAt: undefined,
    expiresAt: undefined,
  });

  console.log('New admin key (imei:reveal only, shown once -- copy it now):');
  console.log(`  ${key.plaintext}`);
  console.log('');
  console.log('label: admin: imei reveal');
  console.log('');
  console.log('Use it against the reveal route only -- it is refused everywhere else:');
  console.log(
    `  curl -X POST -H "authorization: Bearer ${key.plaintext}" -H "content-type: application/json" ` +
      `-d '{"reason":"..."}' http://localhost:3000/v1/admin/checks/<check_id>/imei/reveal`,
  );
} finally {
  await repos.close();
}
