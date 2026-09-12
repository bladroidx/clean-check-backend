import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTacDirectory } from '../src/lib/tac.js';

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
    expect(() => loadTacDirectory('/nonexistent/tac.json')).toThrow();
  });
});
