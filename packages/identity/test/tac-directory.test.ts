import { describe, expect, it } from 'vitest';
import {
  InMemoryTacDirectory,
  LearningTacDirectory,
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

describe('LearningTacDirectory', () => {
  const base = InMemoryTacDirectory.from(
    [['35847191', entry('Samsung', 'SM-G991B', 'osmocom')]],
    'osmocom-2026-10-12',
    'Osmocom TAC database, CC BY-SA 3.0',
  );

  it('falls back to the base directory for a TAC it has not learned', () => {
    const dir = new LearningTacDirectory(base);
    expect(dir.lookup('35847191')?.model).toBe('SM-G991B');
    expect(dir.lookup('86754208')).toBeUndefined();
  });

  it('answers a learned TAC, and an observation outranks the imported row', () => {
    const dir = new LearningTacDirectory(base);
    dir.learn('86754208', entry('Honor', 'Magic8 Pro', 'observed'));
    dir.learn('35847191', entry('Samsung', 'Galaxy S21 5G', 'observed'));
    expect(dir.lookup('86754208')).toMatchObject({ manufacturer: 'Honor', model: 'Magic8 Pro', source: 'observed' });
    expect(dir.lookup('35847191')?.model).toBe('Galaxy S21 5G');
  });

  it('replaces everything learned when reloaded from the database', () => {
    const dir = new LearningTacDirectory(base);
    dir.learn('11111111', entry('Old', 'Gone', 'observed'));
    dir.replaceLearned([['86754208', entry('Honor', 'Magic8 Pro', 'observed')]]);
    expect(dir.lookup('11111111')).toBeUndefined();
    expect(dir.lookup('86754208')?.manufacturer).toBe('Honor');
  });

  it('names its provenance: base version plus learned count, and keeps the attribution', () => {
    const dir = new LearningTacDirectory(base);
    expect(dir.version).toBe('osmocom-2026-10-12'); // nothing learned: unchanged
    dir.learn('86754208', entry('Honor', 'Magic8 Pro', 'observed'));
    expect(dir.version).toBe('osmocom-2026-10-12+observed.1');
    expect(dir.size).toBe(2);
    expect(dir.attribution).toBe('Osmocom TAC database, CC BY-SA 3.0');
  });
});
