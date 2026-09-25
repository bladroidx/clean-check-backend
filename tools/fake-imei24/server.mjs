// A fake imei24 (DHRU Fusion legacy API) for the local stack. Dev tooling only: it lives outside
// the npm workspaces, so dependency-cruiser, tsc and vitest never see it and nothing in the
// service can import it. The service reaches it the same way it reaches the real supplier -- over
// HTTPS, via IMEI24_BASE_URL -- trusted through NODE_EXTRA_CA_CERTS, so not one line of
// production code knows it exists.
//
// It answers from the provider fixtures verbatim (mounted read-only at FIXTURES_DIR). The only
// bytes it ever changes are the order id in the placement / pending fixtures, because a fixed
// "71970" would make every order the same order.
//
// The scenario is chosen by the IMEI's second-to-last digit (see SCENARIOS.md). It is a rule, not
// a list of numbers, so no IMEI is ever committed; `imei-for.mjs` builds one per scenario at
// runtime with a random serial, which also keeps every run clear of the field cache.
//
// Never logs an IMEI: action, scenario and order reference only.

import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

/** How long an async order stays pending, per scenario (ms after placement). */
export const ASYNC_MS = { 1: 3_000, 6: 60_000 };
/** Longer than the catalogue's 8 s timeout_ms, so the call is abandoned client-side. */
export const TIMEOUT_SCENARIO_SLEEP_MS = 15_000;

/**
 * What each scenario answers. `place` is the placeimeiorder reply; `poll` (async scenarios only)
 * is what getimeiorder returns once the order is done.
 */
export const SCENARIOS = {
  0: { name: 'instant blacklisted', place: 'imei24/blacklist-blacklisted.json' },
  1: { name: 'async fast, then blacklisted', place: 'imei24/placement-order-received.json', poll: 'imei24/blacklist-blacklisted.json' },
  2: { name: 'instant "Clean" wording', place: 'imei24/blacklist-clean-wording.json' },
  3: { name: 'supplier busy', place: 'imei24/busy.json' },
  4: { name: 'timeout', sleepMs: TIMEOUT_SCENARIO_SLEEP_MS, place: 'imei24/busy.json' },
  5: { name: 'not found', place: 'imei24/not-found.json' },
  6: { name: 'async slow, then blacklisted', place: 'imei24/placement-order-received.json', poll: 'imei24/blacklist-blacklisted.json' },
  7: { name: 'ambiguous "Status" label', place: 'imei24/ambiguous-status-label.json' },
  8: { name: 'identity only, no blacklist field', place: 'imei24/instant-model.json' },
  9: { name: 'HTTP 429', status: 429 },
};

const PENDING_FIXTURE = 'dhru/legacy-pending.json';
const FIXTURE_PLACED_ID = '"71970"';
const FIXTURE_PENDING_ID = '"918276"';

/** Scenario digit of a 15-digit IMEI, or undefined for anything else. */
export function scenarioOf(imei) {
  return /^\d{15}$/.test(imei ?? '') ? Number(imei[13]) : undefined;
}

let sequence = 0;
const CLOCK_WRAP_S = 10_000_000; // 7 digits of seconds, ~115 days

/**
 * The order reference carries its own state -- placement second, a sequence number and the
 * scenario -- so a poll needs no memory and survives a restart of this process. imei-check keeps
 * the reference unchanged while an order is pending, so this is all a poll ever needs.
 *
 * Ten digits, deliberately: real imei24 references are short, and a run of 14+ digits anywhere in
 * a log line trips imei-check's IMEI tripwire (it cannot tell an order id from an IMEI).
 */
export function makeReference(scenario, now = Date.now()) {
  sequence = (sequence + 1) % 100;
  const second = Math.floor(now / 1000) % CLOCK_WRAP_S;
  return `${String(second).padStart(7, '0')}${String(sequence).padStart(2, '0')}${scenario}`;
}

export function parseReference(reference, now = Date.now()) {
  if (!/^\d{10}$/.test(reference ?? '')) return undefined;
  const placedSecond = Number(reference.slice(0, 7));
  const nowSecond = Math.floor(now / 1000) % CLOCK_WRAP_S;
  const ageMs = (((nowSecond - placedSecond) % CLOCK_WRAP_S) + CLOCK_WRAP_S) % CLOCK_WRAP_S * 1000;
  return { ageMs, scenario: Number(reference[9]) };
}

/** Decides a reply. Pure apart from the fixture reader, so the tests drive it directly. */
export function reply(form, { readFixture, now = Date.now(), username, apiKey }) {
  const json = (body, status = 200) => ({ status, body });
  const error = (message) => json(`{"ERROR":[{"MESSAGE":"${message}"}]}`);

  if (form.get('username') !== username || form.get('apiaccesskey') !== apiKey) {
    return { ...error('Authentication Failed'), status: 401, log: 'auth failed' };
  }

  switch (form.get('action')) {
    case 'accountinfo':
      return {
        ...json('{"SUCCESS":[{"MESSAGE":"Your Account Info","AccountInfo":{"credit":"100.00","currency":"USD"}}]}'),
        log: 'accountinfo',
      };

    case 'placeimeiorder': {
      const scenario = scenarioOf(form.get('imei'));
      if (scenario === undefined) return { ...error('Invalid IMEI'), log: 'place: invalid imei' };
      const s = SCENARIOS[scenario];
      if (s.status !== undefined) return { status: s.status, body: '', log: `place scenario=${scenario} -> HTTP ${s.status}` };
      if (s.poll === undefined) {
        return { ...json(readFixture(s.place)), sleepMs: s.sleepMs, log: `place scenario=${scenario} (${s.name})` };
      }
      const reference = makeReference(scenario, now);
      return {
        ...json(readFixture(s.place).replace(FIXTURE_PLACED_ID, `"${reference}"`)),
        log: `place scenario=${scenario} (${s.name}) ref=${reference}`,
      };
    }

    case 'getimeiorder': {
      const reference = form.get('id');
      const parsed = parseReference(reference, now);
      const s = parsed && SCENARIOS[parsed.scenario];
      if (s?.poll === undefined) return { ...error('Order not found'), log: `poll ref=${reference}: not found` };
      const pending = parsed.ageMs < ASYNC_MS[parsed.scenario];
      return pending
        ? { ...json(readFixture(PENDING_FIXTURE).replace(FIXTURE_PENDING_ID, `"${reference}"`)), log: `poll ref=${reference}: pending` }
        : { ...json(readFixture(s.poll)), log: `poll ref=${reference}: answered` };
    }

    default:
      return { ...error('Unknown action'), log: `unknown action` };
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function start() {
  const fixturesDir = process.env.FIXTURES_DIR ?? '/fixtures';
  const certDir = process.env.CERT_DIR ?? '/certs';
  const port = Number(process.env.PORT ?? 8443);
  const username = process.env.FAKE_IMEI24_USERNAME;
  const apiKey = process.env.FAKE_IMEI24_API_KEY;
  if (!username || !apiKey) {
    console.error('FAKE_IMEI24_USERNAME and FAKE_IMEI24_API_KEY are required');
    process.exit(1);
  }
  // Read per request, trimmed of the trailing newline the fixture files end with.
  const readFixture = (name) => readFileSync(join(fixturesDir, name), 'utf8').trimEnd();

  const server = createServer(
    { key: readFileSync(join(certDir, 'server.key')), cert: readFileSync(join(certDir, 'server.crt')) },
    async (request, response) => {
      const url = new URL(request.url ?? '/', 'https://fake-imei24');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/api/index.php') {
        response.writeHead(404).end();
        return;
      }
      const form = new URLSearchParams(await readBody(request));
      const result = reply(form, { readFixture, username, apiKey });
      console.log(`${new Date().toISOString()} ${result.log}`);
      if (result.sleepMs) await sleep(result.sleepMs);
      // The caller gave up, as the timeout scenario intends.
      if (response.destroyed || request.socket.destroyed) return;
      response.writeHead(result.status, { 'content-type': 'application/json' }).end(result.body);
    },
  );
  server.listen(port, () => console.log(`fake imei24 listening on https://0.0.0.0:${port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) start();
