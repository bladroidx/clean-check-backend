import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { MemoryRepositories } from '../src/db/memory.js';
import { PgRepositories } from '../src/db/pg.js';
import { harvestTac, observationOf } from '../src/tac/harvest.js';

const AT = new Date('2026-10-12T10:00:00Z');
const fields = (manufacturer?: string, model?: string) => [
  ...(manufacturer !== undefined ? [{ field: 'identity.manufacturer' as const, value: manufacturer }] : []),
  ...(model !== undefined ? [{ field: 'identity.model' as const, value: model }] : []),
  { field: 'blacklist.status' as const, value: 'clean' },
];

describe('observationOf', () => {
  it('takes manufacturer and model from a paid answer', () => {
    expect(observationOf('86754208', fields(' Honor ', 'Magic8 Pro '), AT)).toEqual({
      tac: '86754208', manufacturer: 'Honor', model: 'Magic8 Pro', seenAt: AT,
    });
  });

  it('learns nothing without both names, or from a malformed TAC', () => {
    expect(observationOf('86754208', fields('Honor'), AT)).toBeUndefined();
    expect(observationOf('86754208', fields(undefined, 'Magic8 Pro'), AT)).toBeUndefined();
    expect(observationOf('86754208', fields('  ', 'Magic8 Pro'), AT)).toBeUndefined();
    expect(observationOf('8675420', fields('Honor', 'Magic8 Pro'), AT)).toBeUndefined();
    expect(observationOf(undefined, fields('Honor', 'Magic8 Pro'), AT)).toBeUndefined();
  });
});

describe('harvestTac', () => {
  it('stores the observation and tells the caller, so the free tier can answer it at once', async () => {
    const repos = new MemoryRepositories();
    const learned: string[] = [];
    await harvestTac(repos.tac, '86754208', fields('Honor', 'Magic8 Pro'), AT, (o) => learned.push(o.tac));
    expect(await repos.tac.observed()).toEqual([{ tac: '86754208', manufacturer: 'Honor', model: 'Magic8 Pro' }]);
    expect(learned).toEqual(['86754208']);
  });

  it('keeps the latest answer for a TAC rather than duplicating it', async () => {
    const repos = new MemoryRepositories();
    await harvestTac(repos.tac, '86754208', fields('Honor', 'BKQ-N49'), AT);
    await harvestTac(repos.tac, '86754208', fields('Honor', 'Magic8 Pro'), AT);
    expect(await repos.tac.observed()).toEqual([{ tac: '86754208', manufacturer: 'Honor', model: 'Magic8 Pro' }]);
  });

  it('does nothing when the answer names no device', async () => {
    const repos = new MemoryRepositories();
    const learned: string[] = [];
    await harvestTac(repos.tac, '86754208', fields(), AT, (o) => learned.push(o.tac));
    expect(await repos.tac.observed()).toEqual([]);
    expect(learned).toEqual([]);
  });
});

describe('PgTacRepo', () => {
  function fakePool() {
    const calls: { text: string; params: unknown[] }[] = [];
    const pool = {
      query: async (text: string, params: unknown[]) => {
        calls.push({ text, params });
        return { rows: [{ tac: '86754208', manufacturer: 'Honor', model: 'Magic8 Pro' }] };
      },
    } as unknown as pg.Pool;
    return { pool, calls };
  }

  it('upserts an observation that may replace an imported row but never a higher-priority one', async () => {
    const { pool, calls } = fakePool();
    await new PgRepositories(pool).tac.recordObservation({ tac: '86754208', manufacturer: 'Honor', model: 'Magic8 Pro', seenAt: AT });
    const sql = calls[0]?.text ?? '';
    expect(sql).toContain('INSERT INTO tac_entries');
    expect(sql).toContain('ON CONFLICT (tac) DO UPDATE');
    expect(sql).toContain('tac_entries.source_priority <= EXCLUDED.source_priority');
    expect(calls[0]?.params).toEqual(['86754208', 'Honor', 'Magic8 Pro', 'observed', 100, 'harvest', AT]);
  });

  it('reads back only observed rows', async () => {
    const { pool, calls } = fakePool();
    expect(await new PgRepositories(pool).tac.observed()).toEqual([{ tac: '86754208', manufacturer: 'Honor', model: 'Magic8 Pro' }]);
    expect(calls[0]?.text).toContain("WHERE source = 'observed'");
  });
});
