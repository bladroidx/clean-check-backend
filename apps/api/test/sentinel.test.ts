import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { App } from '../src/app.js';
import { SENTINEL, UNKNOWN_TAC_IMEI, makeApp } from './helpers.js';
import { BLOCKED, CLEAN, FakeProvider, REWORDED, TIMEOUT, idempotencyKey, makePaidApp } from './paid-helpers.js';

/**
 * The sentinel test.
 *
 * The only thing that keeps "we never store or log a raw IMEI" true past month three. It runs the
 * sentinel through every path the service has and then goes looking for the digits everywhere
 * output can land.
 *
 * When Postgres is wired, step 2 reads `information_schema` at runtime rather than a hardcoded
 * column list, so a column added next month is covered automatically. Until then it scans the
 * repo, which is where a leak would land today.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude']);
// The vectors and the tests are *supposed* to contain the sentinel: they are how it is asserted.
// README.md is allowed ONLY the documented synthetic example, which the next test pins exactly --
// broadening this list without pinning the content would quietly disable the guard for docs.
const ALLOWED = [
  /testdata\/imei-vectors\.json$/,
  /apps\/api\/test\//,
  /apps\/worker\/test\//,
  /packages\/identity\/test\//,
  /packages\/core\/test\//,
  /packages\/providers\/test\//,
  /(^|\/)README\.md$/,
  // The Bruno collection keeps its test numbers in one environment file so no request contains
  // one. Pinned below, exactly as README.md is.
  /bruno\/environments\/Local\.bru$/,
];

/**
 * A DENYLIST of binary extensions, not an allowlist of text ones.
 *
 * The first version of this test listed the extensions to scan, and silently skipped the `.bru`
 * files added later -- a new file type escaped the sweep without anyone noticing, which is exactly
 * the failure this test exists to prevent. Scan everything; name only what cannot be text.
 */
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf|zip|gz|tgz|node|wasm|xlsx?)$/i;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe('sentinel IMEI', () => {
  it('survives no response body, and no log line, across every path', async () => {
    const { app, logs } = await makeApp();
    const a: App = app;

    const responses: string[] = [];
    for (const imei of [SENTINEL, UNKNOWN_TAC_IMEI, '353104112345670', '12345', 'no digits']) {
      const res = await a.inject({ method: 'POST', url: '/v1/imei/validate', payload: { imei } });
      responses.push(res.body);
    }
    responses.push((await a.inject({ method: 'GET', url: '/v1/tac/35310411' })).body);
    responses.push((await a.inject({ method: 'GET', url: '/v1/tac/00000000' })).body);
    responses.push(JSON.stringify(a.swagger()));
    await a.close();

    for (const body of responses) {
      expect(body).not.toContain(SENTINEL);
      expect(body).not.toContain(UNKNOWN_TAC_IMEI);
    }
    expect(logs.raw()).not.toContain(SENTINEL);
    expect(logs.raw()).not.toContain(UNKNOWN_TAC_IMEI);
    // Prove the run actually exercised the logger, or the assertion above is vacuous.
    expect(logs.lines.length).toBeGreaterThan(0);
  });

  it('appears in no source, doc or migration outside the places that assert it', () => {
    const offenders: string[] = [];
    for (const file of walk(REPO)) {
      if (ALLOWED.some((re) => re.test(file))) continue;
      if (BINARY.test(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (/\b\d{15}\b/.test(text)) offenders.push(file.replace(`${REPO}/`, ''));
    }
    expect(offenders, `15-digit numbers found in: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * The paid path, which is where the sentinel is most at risk.
   *
   * The free tier never sends the number anywhere. The paid path hands the raw digits to a
   * supplier, receives free text back, writes a cache row, a ledger row, a provider_calls row and
   * a check record, and serialises a report -- every one of which is a place the digits could
   * land. Running the sentinel through all four arms and then grepping everything the process
   * produced is the only way that stays true past month three.
   */
  it('survives the whole PAID path: no response, log, cache row or stored section holds it', async () => {
    for (const outcome of [CLEAN, BLOCKED, REWORDED, TIMEOUT]) {
      const harness = await makePaidApp({ providers: [new FakeProvider('fake', outcome)], credits: 500 });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/checks',
        headers: { ...harness.auth(), 'idempotency-key': idempotencyKey() },
        payload: { imei: SENTINEL, capabilities: ['blacklist.gsma', 'identity.model'] },
      });

      expect(response.body).not.toContain(SENTINEL);
      expect(harness.logs.raw()).not.toContain(SENTINEL);

      const checkId = response.json().check_id as string;
      const stored = await harness.repos.checks.sections(checkId);
      expect(JSON.stringify(stored)).not.toContain(SENTINEL);

      const record = await harness.repos.checks.byId('ten_test', checkId);
      expect(JSON.stringify(record)).not.toContain(SENTINEL);

      const ledger = await harness.repos.credits.ledger('ten_test', 100);
      expect(JSON.stringify(ledger)).not.toContain(SENTINEL);

      // The cache is keyed on the INTERNAL hash, never the digits.
      const cached = await harness.repos.cache.get(`${SENTINEL}:blacklist.status`);
      expect(cached).toBeUndefined();

      // And the balance query path, and the capabilities preview.
      const capabilities = await harness.app.inject({
        method: 'POST',
        url: '/v1/capabilities',
        headers: harness.auth(),
        payload: { imei: SENTINEL },
      });
      expect(capabilities.body).not.toContain(SENTINEL);

      const fetched = await harness.app.inject({
        method: 'GET',
        url: `/v1/checks/${checkId}`,
        headers: harness.auth(),
      });
      expect(fetched.body).not.toContain(SENTINEL);

      await harness.app.close();
    }
  });

  it('does not leak the sentinel through a supplier error message', async () => {
    // The realistic leak: a supplier echoes the IMEI inside free text and we hand that straight
    // to the logger or to the caller.
    const harness = await makePaidApp({
      providers: [
        new FakeProvider('fake', {
          kind: 'failed',
          reason: 'http_error',
          detail: `provider said: no record for ${SENTINEL}`,
        }),
      ],
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { ...harness.auth(), 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL, capabilities: ['blacklist.gsma'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SENTINEL);
    expect(harness.logs.raw()).not.toContain(SENTINEL);
    await harness.app.close();
  });

  it('the README carries only the one documented synthetic example', () => {
    // README.md is allowlisted above. Pin what it may contain, or the allowlist is a hole.
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
    const found = [...new Set(readme.match(/\b\d{15}\b/g) ?? [])];
    expect(found).toEqual([SENTINEL]);
  });

  it('the Bruno environment carries only the declared synthetic numbers', () => {
    // Same reasoning: an allowlisted file whose contents are not pinned is just a hole.
    const env = readFileSync(join(REPO, 'bruno/environments/Local.bru'), 'utf8');
    const found = [...new Set(env.match(/\b\d{15}\b/g) ?? [])].sort();
    expect(found).toEqual(
      [SENTINEL, UNKNOWN_TAC_IMEI, '353104112345670', '356920051234564'].sort(),
    );
  });
});
