import { readFileSync } from 'node:fs';
import { InMemoryTacDirectory, type TacEntry, type TacSource } from '@imei-check/identity';

/**
 * Loads the TAC directory into memory at boot.
 *
 * ~250k rows at ~60 bytes is ~15 MB, which is what lets the free tier answer in microseconds with
 * zero database round trips -- and that is what makes it safe to give away.
 */

interface TacFile {
  version: string;
  attribution?: string;
  source: TacSource;
  entries: Record<string, { manufacturer: string; model: string; marketingName?: string }>;
}

export function loadTacDirectory(path: string): InMemoryTacDirectory {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as TacFile;
  const rows: Array<readonly [string, TacEntry]> = Object.entries(raw.entries).map(([tac, e]) => [
    tac,
    {
      manufacturer: e.manufacturer,
      model: e.model,
      ...(e.marketingName ? { marketingName: e.marketingName } : {}),
      source: raw.source,
    },
  ]);
  return InMemoryTacDirectory.from(rows, raw.version, raw.attribution);
}
