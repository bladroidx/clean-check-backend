import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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

/**
 * A boot failure that names the file and nothing else wastes the operator's afternoon.
 *
 * The realistic cause is not a missing repo file -- it is a RELATIVE `TAC_SOURCE_FILE` in a `.env`,
 * resolved against a cwd the author did not have in mind. `npm run dev` starts in `apps/api` under
 * npm workspaces; Docker's `node apps/api/dist/server.js` starts in the repo root. A path that is
 * correct from one is wrong from the other, which is exactly why the default in `config.ts` is
 * absolute. So say which variable did it, what it resolved to, and what to do about it.
 */
export class TacDirectoryUnreadable extends Error {
  constructor(configured: string, resolved: string, cwd: string, cause: unknown) {
    super(
      `Could not read the TAC directory at '${resolved}'.\n` +
        `  TAC_SOURCE_FILE = ${configured}\n` +
        `  resolved against cwd = ${cwd}\n` +
        (isAbsolute(configured)
          ? `  The path is absolute, so check the file exists and is readable.`
          : `  The path is RELATIVE, so it depends on where the process was started. ` +
            `'npm run dev' starts in apps/api; Docker starts in the repo root.\n` +
            `  Unset TAC_SOURCE_FILE (comment it out in .env) to use the built-in absolute ` +
            `default, which is correct from either.`),
      { cause },
    );
    this.name = 'TacDirectoryUnreadable';
  }
}

export function loadTacDirectory(path: string): InMemoryTacDirectory {
  const resolved = resolve(path);
  let contents: string;
  try {
    contents = readFileSync(resolved, 'utf8');
  } catch (cause) {
    throw new TacDirectoryUnreadable(path, resolved, process.cwd(), cause);
  }

  const raw = JSON.parse(contents) as TacFile;
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
