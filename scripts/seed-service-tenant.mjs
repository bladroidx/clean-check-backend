#!/usr/bin/env node
/**
 * Seeds the one service tenant for single-consumer mode, and a fresh API key for it.
 *
 * This service has exactly one caller right now: the check-this-phone backend. There is no
 * self-serve signup, no plans, no credit top-up here -- billing was removed entirely, so nothing
 * is ever reserved or ledgered against this tenant and there is no balance to seed. The tenant row
 * exists only because `checks`/`provider_calls`/`cache_entries`/`idempotency_records` all carry a
 * `tenant_id` foreign key; it is infrastructure, not a customer account.
 *
 * Idempotent for the fixed tenant id: safe to re-run to mint an additional key (e.g. for
 * rotation), but never creates a second tenant.
 *
 * Never run this against a production database without checking `SEED_TENANT_ID` first: it prints
 * the plaintext key to stdout.
 */
import { PgRepositories, createPool, generateTenantSalt } from '@imei-check/core';
import { generateApiKey } from '../apps/api/dist/auth/keys.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined) {
  console.error('DATABASE_URL is required. Example:');
  console.error(
    '  DATABASE_URL=postgres://imei:imei@localhost:5432/imei_check node scripts/seed-service-tenant.mjs',
  );
  process.exit(1);
}

const TENANT_ID = process.env.SEED_TENANT_ID ?? 'ten_check_this_phone';
const live = process.env.SEED_LIVE_KEY === 'true';

const repos = new PgRepositories(createPool(DATABASE_URL));

try {
  const existing = await repos.tenants.byId(TENANT_ID);
  if (existing === undefined) {
    await repos.tenants.create({
      id: TENANT_ID,
      name: 'check-this-phone backend (service tenant)',
      plan: 'standard',
      status: 'active',
      imeiSalt: generateTenantSalt(),
    });
    console.log(`Created service tenant '${TENANT_ID}'.`);
  } else {
    console.log(`Service tenant '${TENANT_ID}' already exists.`);
  }

  const key = generateApiKey(live);
  await repos.apiKeys.insert({
    id: `key_${Date.now()}`,
    tenantId: TENANT_ID,
    prefix: key.prefix,
    keySha256: key.sha256,
    scopes: ['checks:write', 'imei:read'],
    revokedAt: undefined,
    expiresAt: undefined,
  });

  console.log('');
  console.log('New API key (shown once -- copy it now):');
  console.log(`  ${key.plaintext}`);
  console.log('');
  console.log('Hand this to the check-this-phone backend as its Authorization credential:');
  console.log(`  curl -H "authorization: Bearer ${key.plaintext}" http://localhost:3000/v1/imei/validate ...`);
  console.log(`  curl -H "authorization: Bearer ${key.plaintext}" http://localhost:3000/v1/checks ...`);
} finally {
  await repos.close();
}
