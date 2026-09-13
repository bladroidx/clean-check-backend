import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TacDirectoryUnreadable, loadTacDirectory } from '../src/lib/tac.js';

const write = (content: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'imei-tac-'));
  const file = join(dir, 'tac.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
};

describe('loadTacDirectory', () => {
  it('loads entries with their version and attribution', () => {
    const dir = loadTacDirectory(
      write({
        version: 'osmocom-2026-09-01',
        source: 'osmocom',
        attribution: 'TAC data (c) Osmocom contributors, CC BY-SA 3.0',
        entries: {
          '35310411': { manufacturer: 'Apple', model: 'iPhone 13', marketingName: 'iPhone 13' },
        },
      }),
    );
    expect(dir.size).toBe(1);
    expect(dir.version).toBe('osmocom-2026-09-01');
    // CC BY-SA requires the credit, and we surface it in coverage.attribution on every answer.
    expect(dir.attribution).toContain('CC BY-SA');
    expect(dir.lookup('35310411')).toMatchObject({ manufacturer: 'Apple', source: 'osmocom' });
  });

  it('omits marketingName rather than setting it undefined', () => {
    const dir = loadTacDirectory(
      write({
        version: 'v1',
        source: 'bundled',
        entries: { '86124503': { manufacturer: 'Xiaomi', model: 'M2101K6G' } },
      }),
    );
    expect(dir.lookup('86124503')).not.toHaveProperty('marketingName');
    expect(dir.attribution).toBeUndefined();
  });

  it('tags every row with the file source, so priority ordering works', () => {
    const dir = loadTacDirectory(
      write({ version: 'v1', source: 'observed', entries: { '11111111': { manufacturer: 'A', model: 'B' } } }),
    );
    expect(dir.lookup('11111111')?.source).toBe('observed');
  });

  it('throws on a missing file rather than starting with an empty directory', () => {
    // Booting with a silently empty directory would turn every identity answer into
    // "TAC not found" -- honest, but a total capability loss nobody would notice.
    expect(() => loadTacDirectory('/nonexistent/tac.json')).toThrow(TacDirectoryUnreadable);
  });

  /**
   * The message is the feature here.
   *
   * A bare ENOENT naming only the file sent a developer round the houses twice: the realistic
   * cause is a RELATIVE `TAC_SOURCE_FILE` in a `.env`, resolved against a cwd the author did not
   * have in mind (`npm run dev` starts in apps/api; Docker starts in the repo root). The error has
   * to name the variable, show what it resolved to and from where, and say what to do.
   */
  it('explains a relative path failure well enough to fix it without reading the source', () => {
    let message = '';
    try {
      loadTacDirectory('testdata/definitely-not-here.json');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('TAC_SOURCE_FILE');
    expect(message).toContain('RELATIVE');
    expect(message).toContain('cwd');
    expect(message).toContain(process.cwd());
    // The actionable instruction, not just the diagnosis.
    expect(message).toMatch(/comment it out|Unset/);
  });

  it('does not blame relative resolution when the path was absolute', () => {
    let message = '';
    try {
      loadTacDirectory('/nonexistent/tac.json');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('absolute');
    expect(message).not.toContain('RELATIVE');
  });

  it('keeps the original error as `cause`, so the real errno is not lost', () => {
    try {
      loadTacDirectory('/nonexistent/tac.json');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).cause).toMatchObject({ code: 'ENOENT' });
    }
  });
});
