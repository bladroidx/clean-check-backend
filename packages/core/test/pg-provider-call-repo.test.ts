import { describe, expect, it } from 'vitest';
import { PgRepositories } from '../src/db/pg.js';
import type pg from 'pg';

/**
 * `PgProviderCallRepo.finish` is not exported, so it is reached the way production reaches it:
 * through `PgRepositories.providerCalls`. No real Postgres runs here (this branch has no
 * testcontainers/pg test setup) -- instead a fake pool records the query text and params, which is
 * enough to pin the UPDATE shape without a database.
 *
 * This guards the New Breakage #1 finding in final-rereview.md: `finish` used to leave
 * `provider_cost_usd` untouched, so every row kept the catalogue price `onCallStart` wrote even
 * when the router later decided the attempt cost 0 (dedupe hit, spend-cap refusal, lock-busy
 * rate_limited, a failing beforeSend) -- and `costSinceForProvider` (the daily spend cap) sums
 * exactly that column.
 */
function fakePool() {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

describe('PgProviderCallRepo.finish', () => {
  it('sets provider_cost_usd from the patch, including a final cost of 0', async () => {
    const { pool, calls } = fakePool();
    const repo = new PgRepositories(pool).providerCalls;

    await repo.finish('attempt-1', {
      status: 'failed',
      latencyMs: 5,
      billable: false,
      errorCode: 'spend_cap_reached',
      finishedAt: new Date('2026-09-25T00:00:00Z'),
      providerCostUsd: 0,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('expected one query');
    expect(call.text).toContain('provider_cost_usd = COALESCE($7, provider_cost_usd)');
    expect(call.params[6]).toBe(0);
  });

  it('leaves provider_cost_usd alone when the patch omits it', async () => {
    const { pool, calls } = fakePool();
    const repo = new PgRepositories(pool).providerCalls;

    await repo.finish('attempt-2', { status: 'answered' });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('expected one query');
    expect(call.params[6]).toBeNull();
  });
});
