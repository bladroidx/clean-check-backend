#!/usr/bin/env node
/**
 * Seeds one development tenant and a fresh API key. Billing was removed entirely -- there is no
 * credit balance to top up here.
 *
 * The paid routes (`POST /v1/checks`, ...) only exist when the server is started with
 * `DATABASE_URL` set (see `apps/api/src/app.ts`) -- there is no tenant to authenticate against
 * otherwise. This script is the fast path from "empty database" to "a key I can paste into Bruno
 * or curl", for local development only.
 *
 * Never run this against a production database: it is idempotent for a single fixed tenant id, not
 * a general-purpose provisioning tool, and it prints the plaintext key to stdout.
 */
import { PgRepositories, createPool, generateTenantSalt } from '@imei-check/core';
import { generateApiKey } from '../apps/api/dist/auth/keys.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined) {
  console.error('DATABASE_URL is required. Example:');
  console.error('  DATABASE_URL=postgres://imei:imei@localhost:5432/imei_check node scripts/seed-dev-tenant.mjs');
  process.exit(1);
}

const TENANT_ID = process.env.SEED_TENANT_ID ?? 'ten_dev';

const repos = new PgRepositories(createPool(DATABASE_URL));

try {
  const existing = await repos.tenants.byId(TENANT_ID);
  if (existing === undefined) {
    await repos.tenants.create({
      id: TENANT_ID,
      name: 'Dev tenant (seeded)',
      plan: 'standard',
      status: 'active',
      imeiSalt: generateTenantSalt(),
    });
    console.log(`Created tenant '${TENANT_ID}'.`);
  } else {
    console.log(`Tenant '${TENANT_ID}' already exists.`);
  }

  const key = generateApiKey(/* live */ false);
  await repos.apiKeys.insert({
    id: `key_${Date.now()}`,
    tenantId: TENANT_ID,
    prefix: key.prefix,
    keySha256: key.sha256,
    scopes: ['checks:write'],
    revokedAt: undefined,
    expiresAt: undefined,
  });

  console.log('');
  console.log('New API key (shown once -- copy it now):');
  console.log(`  ${key.plaintext}`);
  console.log('');
  console.log('Use it as:');
  console.log(`  curl -H "authorization: Bearer ${key.plaintext}" http://localhost:3000/v1/checks ...`);
  console.log('');
  console.log('Or for the Bruno "Paid" folder:');
  console.log(`  BRUNO_API_KEY=${key.plaintext} npm run api:test:paid`);
} finally {
  await repos.close();
}
