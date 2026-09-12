import { describe, expect, it } from 'vitest';
import {
  InMemoryTacDirectory,
  manufacturerMatches,
  type TacEntry,
} from '../src/tac-directory.js';

const entry = (manufacturer: string, model: string, source: TacEntry['source']): TacEntry => ({
  manufacturer,
  model,
  source,
});

describe('InMemoryTacDirectory', () => {
  it('looks up a known TAC and misses an unknown one', () => {
    const dir = InMemoryTacDirectory.from(
      [['35310411', entry('Apple', 'iPhone 13', 'osmocom')]],
      'osmocom-2026-09-01',
    );
    expect(dir.lookup('35310411')?.model).toBe('iPhone 13');
    expect(dir.lookup('99999999')).toBeUndefined();
    expect(dir.size).toBe(1);
  });

  it('prefers a higher-priority source on conflict, whatever the order', () => {
    // An observed row is a fact we own outright; an Osmocom import must never overwrite it.
    const observedLast = InMemoryTacDirectory.from(
      [
        ['35310411', entry('Apple', 'wrong from import', 'osmocom')],
        ['35310411', entry('Apple', 'iPhone 13 Pro', 'observed')],
      ],
      'v1',
    );
    const observedFirst = InMemoryTacDirectory.from(
      [
        ['35310411', entry('Apple', 'iPhone 13 Pro', 'observed')],
        ['35310411', entry('Apple', 'wrong from import', 'osmocom')],
      ],
      'v1',
    );
    expect(observedLast.lookup('35310411')?.model).toBe('iPhone 13 Pro');
    expect(observedFirst.lookup('35310411')?.model).toBe('iPhone 13 Pro');
  });

  it('carries a version and an attribution for coverage metadata', () => {
    // A result whose provenance cannot be named is not evidence, and CC-BY-SA requires the credit.
    const dir = InMemoryTacDirectory.from([], 'osmocom-2026-09-01', 'TAC data (c) Osmocom, CC BY-SA 3.0');
    expect(dir.version).toBe('osmocom-2026-09-01');
    expect(dir.attribution).toContain('CC BY-SA');
  });
});

describe('manufacturerMatches', () => {
  it('compares manufacturer only, case-insensitively', () => {
    // Deliberately loose, ported from ImeiVerifier.kt: a seller says "Galaxy S21" and the TAC
    // table says "SM-G991B". Comparing models would fail an honest phone.
    const e = entry('Samsung', 'SM-G991B', 'osmocom');
    expect(manufacturerMatches(e, 'samsung')).toBe(true);
    expect(manufacturerMatches(e, '  SAMSUNG ')).toBe(true);
    expect(manufacturerMatches(e, 'Apple')).toBe(false);
  });
});
