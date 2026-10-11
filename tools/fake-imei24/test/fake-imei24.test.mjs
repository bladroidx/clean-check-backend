// node --test tools/fake-imei24/test   (outside vitest on purpose: this is dev tooling)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reply, scenarioOf, makeReference, parseReference, ASYNC_MS } from '../server.mjs';
import { imeiFor } from '../imei-for.mjs';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'packages', 'providers', 'test', 'fixtures');
const readFixture = (name) => readFileSync(join(FIXTURES, name), 'utf8').trimEnd();
const opts = (now = Date.now()) => ({ readFixture, now, username: 'u', apiKey: 'k' });
const form = (fields) => new URLSearchParams({ username: 'u', apiaccesskey: 'k', ...fields });
// Real DHRU: an order's arguments travel as base64 XML in one `parameters` field.
const params = (values) =>
  Buffer.from(`<PARAMETERS>${Object.entries(values).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</PARAMETERS>`).toString('base64');
const place = (imei) => form({ action: 'placeimeiorder', parameters: params({ IMEI: imei, ID: '12' }) });
const poll = (id) => form({ action: 'getimeiorder', parameters: params({ ID: id }) });

// Luhn over all 15 digits, written independently of imei-for.mjs.
const luhnValid = (imei) =>
  [...imei].reverse().reduce((sum, c, i) => {
    let d = Number(c) * (i % 2 === 1 ? 2 : 1);
    return sum + (d > 9 ? d - 9 : d);
  }, 0) % 10 === 0;

test('imeiFor builds a Luhn-valid IMEI that selects its scenario', () => {
  for (let s = 0; s <= 9; s++) {
    const imei = imeiFor(String(s));
    assert.match(imei, /^\d{15}$/);
    assert.ok(luhnValid(imei));
    assert.equal(scenarioOf(imei), s);
  }
});

test('a wrong key is refused', () => {
  const r = reply(new URLSearchParams({ username: 'u', apiaccesskey: 'nope', action: 'accountinfo' }), opts());
  assert.equal(r.status, 401);
});

test('instant scenarios answer from their fixture verbatim', () => {
  const r = reply(place(imeiFor('0')), opts());
  assert.equal(r.body, readFixture('imei24/blacklist-blacklisted.json'));
  assert.equal(reply(place(imeiFor('9')), opts()).status, 429);
  assert.equal(reply(place(imeiFor('4')), opts()).sleepMs, 15_000);
});

test('an async order is pending until its delay passes, then answered', () => {
  const placedAt = Date.now();
  const placed = reply(place(imeiFor('1')), opts(placedAt));
  const reference = JSON.parse(placed.body).SUCCESS[0].REFERENCEID;
  assert.match(reference, /^\d{10}$/); // under the 14-digit IMEI tripwire

  const early = reply(poll(reference), opts(placedAt + 1_000));
  assert.equal(JSON.parse(early.body).SUCCESS[0].STATUS, 'Pending');
  assert.equal(JSON.parse(early.body).SUCCESS[0].ID, reference);

  const late = reply(poll(reference), opts(placedAt + ASYNC_MS[1] + 1_000));
  assert.equal(late.body, readFixture('imei24/blacklist-blacklisted.json'));
});

test('references are unique within a second and round-trip', () => {
  const now = Date.now();
  const a = makeReference(6, now);
  const b = makeReference(6, now);
  assert.notEqual(a, b);
  assert.equal(parseReference(a, now + 5_000).scenario, 6);
  assert.ok(Math.abs(parseReference(a, now + 5_000).ageMs - 5_000) <= 1_000);
  assert.equal(reply(poll('garbage'), opts()).body, '{"ERROR":[{"MESSAGE":"Order not found"}]}');
});

test('top-level imei/services fields are not DHRU: the order is refused like the real supplier does', () => {
  const r = reply(form({ action: 'placeimeiorder', services: '12', imei: imeiFor('0') }), opts());
  assert.equal(r.body, '{"ERROR":[{"MESSAGE":"Not Enought Parameters"}]}');
});
