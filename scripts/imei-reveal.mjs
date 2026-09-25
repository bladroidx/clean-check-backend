#!/usr/bin/env node
/**
 * `npm run imei:reveal -- <check_id> --reason "<text>"`
 *
 * The CLI half of ADR-0007's one reveal code path (packages/core/src/crypto/reveal.ts) -- shared
 * with `POST /v1/admin/checks/:id/imei/reveal` so the audit-before-decrypt ordering cannot drift
 * between the two. Actor is recorded as `'cli'`, distinguishing it in `imei_reveals` from an
 * `api:<key id>` row written by the HTTP route.
 *
 * Prints ONLY the IMEI on success, and a digit-free message on any failure -- this script's own
 * output is exactly the kind of place ADR-0003/0007 exist to keep clean.
 */
import { PgRepositories, createPool, ImeiCipher, revealImei } from '@imei-check/core';

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const KEYS = process.env.IMEI_ENCRYPTION_KEYS;
if (KEYS === undefined) {
  console.error('IMEI_ENCRYPTION_KEYS is required.');
  process.exit(1);
}

const args = process.argv.slice(2);
const checkId = args[0];
const reasonIndex = args.indexOf('--reason');
const reason = reasonIndex >= 0 ? args[reasonIndex + 1] : undefined;

if (checkId === undefined || checkId.startsWith('--') || reason === undefined) {
  console.error('Usage: node scripts/imei-reveal.mjs <check_id> --reason "<text>"');
  process.exit(1);
}

let cipher;
try {
  cipher = ImeiCipher.fromKeyring(KEYS);
} catch {
  console.error('IMEI_ENCRYPTION_KEYS is malformed.');
  process.exit(1);
}

const TENANT_ID = process.env.SEED_TENANT_ID ?? 'ten_check_this_phone';
const repos = new PgRepositories(createPool(DATABASE_URL));

try {
  const result = await revealImei(
    { repos, cipher },
    { tenantId: TENANT_ID, checkId, actor: 'cli', reason },
  );

  if (result.kind === 'not_found') {
    console.error('No such check for this tenant.');
    process.exit(1);
  }
  if (result.kind === 'not_stored') {
    console.error('This check predates encrypted IMEI storage (ADR-0007).');
    process.exit(1);
  }

  console.log(result.imei);
} catch {
  // Never echo the underlying error: it could carry a supplier body or another digit-shaped value.
  console.error('The IMEI could not be revealed.');
  process.exit(1);
} finally {
  await repos.close();
}
