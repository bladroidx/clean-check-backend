#!/usr/bin/env node
/**
 * Builds data/tac/tac-directory.json, the free tier's TAC directory, from a pinned Osmocom snapshot.
 *
 * ADR-0005: Osmocom, used directly and attributed (CC BY-SA 3.0). Its site serves a mismatched TLS
 * certificate, so the snapshot is committed and checksummed rather than trusted on the wire. To update:
 *   1. curl -k -o data/tac/osmocom-tacdb-YYYY-MM-DD.csv https://tacdb.osmocom.org/export/tacdb.csv
 *   2. look the file over, then set SNAPSHOT and SHA256 below
 *   3. npm run tac:build
 * Devices learned from paid answers live in tac_entries (source 'observed') and outrank every row here.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SNAPSHOT = 'data/tac/osmocom-tacdb-2026-10-12.csv';
const SHA256 = '8bf210a2066d51157469d5ba99a0f77340b9fc8b9f521d10acddaff4c9bef1af';
const VERSION = 'osmocom-2026-10-12';
const ATTRIBUTION =
  'Osmocom TAC database (c) Harald Welte and contributors, CC BY-SA 3.0, https://tacdb.osmocom.org';
const OUT = 'data/tac/tac-directory.json';

/** RFC 4180 enough for this file: quoted fields with commas and doubled quotes. */
export function splitCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; } else quoted = !quoted;
    } else if (c === ',' && !quoted) { out.push(current.trim()); current = ''; }
    else current += c;
  }
  out.push(current.trim());
  return out;
}

/**
 * Osmocom's columns: tac, brand, model, contributor, comment, gsmarena, gsmarena, aka.
 * A row without an 8-digit TAC or a brand is skipped, never coerced: a padded TAC would file a real
 * device under a neighbour's code.
 */
export function buildEntries(csv) {
  const entries = {};
  let skipped = 0;
  for (const raw of csv.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const [tac, brand, model] = splitCsvLine(line);
    if (!/^\d{8}$/.test(tac ?? '') || !brand) { skipped += 1; continue; }
    entries[tac] = { manufacturer: brand, model: model || brand };
  }
  return { entries, skipped };
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const csv = readFileSync(root + SNAPSHOT, 'utf8');
  const actual = createHash('sha256').update(csv, 'utf8').digest('hex');
  if (actual !== SHA256) {
    console.error(`${SNAPSHOT}: sha256 ${actual}, expected ${SHA256}. Refusing to build from an unverified snapshot.`);
    process.exit(1);
  }
  const { entries, skipped } = buildEntries(csv);
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    root + OUT,
    JSON.stringify({ version: VERSION, attribution: ATTRIBUTION, source: 'osmocom', entries: sorted }) + '\n',
  );
  console.log(`${OUT}: ${Object.keys(sorted).length} devices (${skipped} lines skipped) from ${SNAPSHOT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
