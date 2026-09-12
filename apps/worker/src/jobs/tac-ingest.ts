import { createHash } from 'node:crypto';
import type { TacSource } from '@imei-check/identity';

/**
 * TAC directory ingest.
 *
 * Two constraints from ADR-0005 shape this, and both are legal rather than technical:
 *
 * 1. **Osmocom's CSV is fetched over a mismatched TLS certificate** (it serves
 *    `fandango.binarybase.org`). So the transport is not trusted: the payload is checksummed and
 *    the checksum is compared against one we pin. A bad checksum aborts the import rather than
 *    replacing a good directory with whatever answered.
 * 2. **Source priority decides conflicts.** `observed` rows -- `(TAC -> model)` facts harvested
 *    from paid supplier responses -- are ours outright with no licence attached, so they outrank
 *    an Osmocom row and an import must never overwrite one.
 *
 * Harvesting is the real long game: after a few thousand paid lookups the observed table covers
 * exactly the devices people actually check, licence-clean, and it compounds.
 */

export interface TacRow {
  readonly tac: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly marketingName?: string;
}

export interface IngestResult {
  readonly parsed: number;
  readonly skipped: number;
  readonly checksum: string;
  readonly sourceVersion: string;
}

export class ChecksumMismatch extends Error {
  constructor(expected: string, actual: string) {
    super(`TAC import checksum mismatch: expected ${expected}, got ${actual}`);
    this.name = 'ChecksumMismatch';
  }
}

export function checksumOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Parses the CSV.
 *
 * Rows whose TAC is not exactly eight digits are skipped rather than coerced. A "TAC" of seven
 * digits is a corrupt row, and left-padding it would file a real device's identity under a
 * neighbour's code -- a wrong model name attached to a real handset, permanently, because
 * `tac -> model` is cached with an infinite TTL.
 */
export function parseTacCsv(body: string): { rows: TacRow[]; skipped: number } {
  const rows: TacRow[] = [];
  let skipped = 0;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const parts = splitCsvLine(trimmed);
    const [tac, manufacturer, model, marketingName] = parts;

    if (tac === undefined || !/^\d{8}$/.test(tac)) {
      skipped += 1;
      continue;
    }
    if (manufacturer === undefined || manufacturer.length === 0) {
      skipped += 1;
      continue;
    }
    if (tac.toLowerCase() === 'tac') continue;

    rows.push({
      tac,
      manufacturer,
      model: model !== undefined && model.length > 0 ? model : manufacturer,
      ...(marketingName !== undefined && marketingName.length > 0 ? { marketingName } : {}),
    });
  }
  return { rows, skipped };
}

/** Minimal RFC 4180: quoted fields with embedded commas are real in device names. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out;
}

export interface TacWriter {
  upsert(row: TacRow & { source: TacSource; sourcePriority: number; sourceVersion: string }): Promise<void>;
}

export const SOURCE_PRIORITY: Readonly<Record<TacSource, number>> = {
  observed: 100,
  paid: 50,
  osmocom: 10,
  bundled: 1,
};

export async function ingestTacCsv(args: {
  body: string;
  expectedChecksum?: string;
  source: TacSource;
  sourceVersion: string;
  writer: TacWriter;
}): Promise<IngestResult> {
  const checksum = checksumOf(args.body);
  if (args.expectedChecksum !== undefined && args.expectedChecksum !== checksum) {
    // Abort rather than import. A directory is served to every free-tier caller; replacing a good
    // one with an unverified payload is worse than serving a month-old one.
    throw new ChecksumMismatch(args.expectedChecksum, checksum);
  }

  const { rows, skipped } = parseTacCsv(args.body);
  for (const row of rows) {
    await args.writer.upsert({
      ...row,
      source: args.source,
      sourcePriority: SOURCE_PRIORITY[args.source],
      sourceVersion: args.sourceVersion,
    });
  }

  return { parsed: rows.length, skipped, checksum, sourceVersion: args.sourceVersion };
}

/**
 * Harvests a `(TAC -> model)` observation from a paid response.
 *
 * This is the licence-clean path: the fact came from a supplier answer we paid for, so it carries
 * no attribution obligation and outranks every imported row.
 */
export function observationFrom(
  tac: string,
  manufacturer: string | undefined,
  model: string | undefined,
): (TacRow & { source: TacSource; sourcePriority: number }) | undefined {
  if (!/^\d{8}$/.test(tac)) return undefined;
  if (manufacturer === undefined || model === undefined) return undefined;
  if (manufacturer.trim().length === 0 || model.trim().length === 0) return undefined;
  return {
    tac,
    manufacturer: manufacturer.trim(),
    model: model.trim(),
    source: 'observed',
    sourcePriority: SOURCE_PRIORITY.observed,
  };
}
