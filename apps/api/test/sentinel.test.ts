import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BUILTIN_LEXICONS,
  DhruLegacyProvider,
  loadCatalogueFile,
  type CatalogueService,
  type ExecuteRequest,
  type ProviderOutcome,
} from '@imei-check/providers';
import type { App } from '../src/app.js';
import { SENTINEL, UNKNOWN_TAC_IMEI, makeApp } from './helpers.js';
import { BLOCKED, CLEAN, FakeProvider, REWORDED, TIMEOUT, idempotencyKey, makePaidApp } from './paid-helpers.js';

/**
 * Drives the deep path with a REAL `DhruLegacyProvider` over the imei24 doc-derived fixtures
 * (`packages/providers/test/fixtures/imei24/`), so the sentinel exercises the actual
 * extract/lexicon `scrub()` pipeline instead of a fake that never touches it. Network is replaced,
 * not the interpreter: `execute`/`poll` call `interpret()` on a fixture body directly, exactly as
 * `imei24-catalogue.test.ts` does, with `[REDACTED-IMEI]` swapped for the sentinel at runtime so no
 * source file ever contains the digits literally.
 */
class FixtureImei24Provider extends DhruLegacyProvider {
  constructor(
    private readonly body: string,
    services: readonly CatalogueService[],
  ) {
    super({
      providerId: 'imei24',
      baseUrl: 'https://pro.imei24.com',
      username: 'u',
      apiAccessKey: 'k',
      services,
      lexicons: BUILTIN_LEXICONS,
    });
  }
  override async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
    return this.interpret(this.body, request.service);
  }
  override async poll(_orderReference: string, service: CatalogueService): Promise<ProviderOutcome> {
    return this.interpret(this.body, service);
  }
}

const IMEI24_CATALOGUE = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'providers', 'catalogue', 'imei24.yaml');
const IMEI24_FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'providers', 'test', 'fixtures', 'imei24');
const imei24Services = loadCatalogueFile(IMEI24_CATALOGUE);
const blacklistService = imei24Services.find((s) => s.serviceId === '486');
if (blacklistService === undefined) throw new Error('imei24.yaml no longer has service 486');

/** The doc-derived "Blacklisted" fixture, with an IMEI line prepended so RESULT echoes it. */
function resultEchoBody(): string {
  const fixture = JSON.parse(readFileSync(join(IMEI24_FIXTURES, 'blacklist-blacklisted.json'), 'utf8')) as {
    SUCCESS: Array<{ STATUS: string; RESULT: string }>;
  };
  const [record] = fixture.SUCCESS;
  if (record === undefined) throw new Error('fixture has no SUCCESS record');
  return JSON.stringify({
    SUCCESS: [{ STATUS: record.STATUS, RESULT: `IMEI;${SENTINEL}\n${record.RESULT}` }],
  });
}

/** The doc-derived "not found" fixture, with the sentinel echoed into MESSAGE instead of RESULT. */
function messageEchoBody(): string {
  const fixture = JSON.parse(readFileSync(join(IMEI24_FIXTURES, 'not-found.json'), 'utf8')) as {
    STATUS: string;
    MESSAGE: string;
  };
  return JSON.stringify({ ...fixture, MESSAGE: `${fixture.MESSAGE} (imei ${SENTINEL})` });
}

/**
 * `JSON.stringify` on a `Buffer` (e.g. `checks.imei_encrypted`) yields `{"type":"Buffer","data":[...]}`
 * -- a comma-separated array of byte integers, never the contiguous digit run the repo scan looks
 * for. Re-encoding it as base64 first is the stricter check the brief asks for: a base64 alphabet
 * digit run is exactly the shape that COULD coincidentally read as part of an IMEI, so it is worth
 * checking explicitly rather than trusting that the default array form never will.
 */
function stringifyWithBase64Buffers(value: unknown): string {
  const replace = (input: unknown): unknown => {
    if (Buffer.isBuffer(input)) return input.toString('base64');
    if (Array.isArray(input)) return input.map(replace);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, replace(v)]));
    }
    return input;
  };
  return JSON.stringify(replace(value));
}

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

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude', '.superpowers']); // .superpowers is git-ignored local tooling scratch
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
   * supplier, receives free text back, writes a cache row, a provider_calls row and a check
   * record, and serialises a report -- every one of which is a place the digits could land.
   * Running the sentinel through all four arms and then grepping everything the process produced
   * is the only way that stays true past month three.
   */
  it('survives the whole PAID path: no response, log, cache row or stored section holds it', async () => {
    for (const outcome of [CLEAN, BLOCKED, REWORDED, TIMEOUT]) {
      const harness = await makePaidApp({ providers: [new FakeProvider('fake', outcome)] });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/deep_checks',
        headers: { ...harness.auth(), 'idempotency-key': idempotencyKey() },
        payload: { imei: SENTINEL, capabilities: ['blacklist.gsma'] },
      });
      // identity.model now lives on the free route only; the free check writes a check record and
      // a stored section too, so it goes through the same sweep.
      const free = await harness.app.inject({
        method: 'POST',
        url: '/v1/checks',
        headers: { ...harness.auth(), 'idempotency-key': idempotencyKey() },
        payload: { imei: SENTINEL, capabilities: ['identity.model', 'blacklist.gsma'] },
      });
      expect(free.statusCode).toBe(200);
      expect(free.body).not.toContain(SENTINEL);
      const freeId = free.json().check_id as string;
      expect(JSON.stringify(await harness.repos.checks.sections(freeId))).not.toContain(SENTINEL);
      expect(JSON.stringify(await harness.repos.checks.byId('ten_test', freeId))).not.toContain(SENTINEL);
      const freeFetched = await harness.app.inject({
        method: 'GET',
        url: `/v1/checks/${freeId}`,
        headers: harness.auth(),
      });
      expect(freeFetched.statusCode).toBe(200);
      expect(freeFetched.body).not.toContain(SENTINEL);

      expect(response.body).not.toContain(SENTINEL);
      expect(harness.logs.raw()).not.toContain(SENTINEL);

      const checkId = response.json().check_id as string;
      const stored = await harness.repos.checks.sections(checkId);
      expect(JSON.stringify(stored)).not.toContain(SENTINEL);

      const record = await harness.repos.checks.byId('ten_test', checkId);
      expect(JSON.stringify(record)).not.toContain(SENTINEL);
      // ADR-0007: the row now carries imei_encrypted as a Buffer. Re-serialise with it as base64
      // rather than JSON.stringify's default {"type":"Buffer","data":[...]} array form -- the
      // stricter of the two shapes to check the ciphertext against.
      expect(stringifyWithBase64Buffers(record)).not.toContain(SENTINEL);

      // The cache is keyed on the INTERNAL hash, never the digits.
      const cached = await harness.repos.cache.get(`${SENTINEL}:blacklist.status`);
      expect(cached).toBeUndefined();

      // And the capabilities preview.
      const capabilities = await harness.app.inject({
        method: 'POST',
        url: '/v1/capabilities',
        headers: harness.auth(),
        payload: { imei: SENTINEL },
      });
      expect(capabilities.body).not.toContain(SENTINEL);

      const fetched = await harness.app.inject({
        method: 'GET',
        url: `/v1/deep_checks/${checkId}`,
        headers: harness.auth(),
      });
      expect(fetched.statusCode).toBe(200);
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
      url: '/v1/deep_checks',
      headers: { ...harness.auth(), 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL, capabilities: ['blacklist.gsma'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SENTINEL);
    expect(harness.logs.raw()).not.toContain(SENTINEL);
    await harness.app.close();
  });

  it('drives the real imei24 interpreter over doc-derived fixtures echoing the sentinel in RESULT and MESSAGE', async () => {
    for (const body of [resultEchoBody(), messageEchoBody()]) {
      const harness = await makePaidApp({
        providers: [new FixtureImei24Provider(body, [blacklistService])],
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/deep_checks',
        headers: { ...harness.auth(), 'idempotency-key': idempotencyKey() },
        payload: { imei: SENTINEL, capabilities: ['blacklist.gsma'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(SENTINEL);
      expect(harness.logs.raw()).not.toContain(SENTINEL);

      const checkId = response.json().check_id as string;
      const stored = await harness.repos.checks.sections(checkId);
      expect(JSON.stringify(stored)).not.toContain(SENTINEL);
      const record = await harness.repos.checks.byId('ten_test', checkId);
      expect(stringifyWithBase64Buffers(record)).not.toContain(SENTINEL);

      await harness.app.close();
    }
  });

  it('the reveal route is the one documented exception: it returns the sentinel, but never logs it', async () => {
    const harness = await makePaidApp();
    const free = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { ...harness.auth(), 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL },
    });
    const checkId = free.json().check_id as string;

    const reveal = await harness.app.inject({
      method: 'POST',
      url: `/v1/admin/checks/${checkId}/imei/reveal`,
      headers: harness.adminAuth(),
      payload: { reason: 'sentinel test: reveal is the one documented exception' },
    });

    expect(reveal.statusCode).toBe(200);
    // The one and only response allowed to contain it.
    expect(reveal.body).toContain(SENTINEL);
    expect(harness.logs.raw()).not.toContain(SENTINEL);

    // But the audit trail it left behind must not.
    const audit = await harness.repos.reveals.forCheck(checkId);
    expect(JSON.stringify(audit)).not.toContain(SENTINEL);

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
