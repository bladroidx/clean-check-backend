#!/usr/bin/env node
// Prints a fresh, valid test IMEI for each fake-imei24 scenario:
//   node imei-for.mjs all            one per scenario
//   node imei-for.mjs 2              just scenario 2
//   node imei-for.mjs all --tac 35310411
//
// TAC + 5 random serial digits + the scenario digit + the Luhn check digit. The serial is random
// so every run is a phone imei-check has never seen: no field-cache hit, no open order to attach
// to, so the request really reaches the fake. Nothing here is ever written to a file.

import { SCENARIOS } from './server.mjs';

export function luhnCheckDigit(body14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body14[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

export function imeiFor(scenario, tac = '35310411') {
  const serial = Array.from({ length: 5 }, () => Math.floor(Math.random() * 10)).join('');
  const body = `${tac}${serial}${scenario}`;
  return body + luhnCheckDigit(body);
}

function main(argv) {
  const which = argv[0] ?? 'all';
  const tacIndex = argv.indexOf('--tac');
  const tac = tacIndex >= 0 ? argv[tacIndex + 1] : '35310411';
  if (!/^\d{8}$/.test(tac ?? '')) {
    console.error('--tac must be 8 digits');
    process.exit(1);
  }
  const scenarios = which === 'all' ? Object.keys(SCENARIOS) : [which];
  for (const s of scenarios) {
    if (SCENARIOS[s] === undefined) {
      console.error(`unknown scenario '${s}' (0-9 or all)`);
      process.exit(1);
    }
    console.log(`${s}  ${imeiFor(s, tac)}  ${SCENARIOS[s].name}`);
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2));
