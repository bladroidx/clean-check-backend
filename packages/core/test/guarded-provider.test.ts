import { describe, expect, it } from 'vitest';
import type { CatalogueService, ExecuteRequest, Provider, ProviderOutcome } from '@imei-check/providers';
import { MemoryRepositories } from '../src/db/memory.js';
import { GuardedProvider } from '../src/providers/guarded.js';

const service = { serviceId: '486', providerId: 'imei24', costUsd: 0.1 } as CatalogueService;
const req = (signal = AbortSignal.timeout(5000)) => ({ capability: 'blacklist.gsma', service, imeiDigits: 'x', signal, referenceId: 'r' }) as ExecuteRequest;

class Slow implements Provider {
  readonly id = 'imei24';
  active = 0; maxActive = 0; calls = 0;
  constructor(private readonly ms: number) {}
  catalogue() { return [service]; }
  supports() { return service; }
  async execute(): Promise<ProviderOutcome> {
    this.calls += 1; this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, this.ms));
    this.active -= 1;
    return { kind: 'answered', fields: [], misses: [] };
  }
}

describe('GuardedProvider', () => {
  it('never runs two imei24 calls at once', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(30);
    const p = new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 1000, dailySpendUsd: 10, costSince: async () => 0 });
    await Promise.all([p.execute(req()), p.execute(req()), p.execute(req())]);
    expect(inner.maxActive).toBe(1);
    expect(inner.calls).toBe(3);
  });

  it('gives up with rate_limited when the lock is not free within the wait', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(200);
    const p = new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 20, dailySpendUsd: 10, costSince: async () => 0 });
    const [a, b] = await Promise.all([p.execute(req()), p.execute(req())]);
    expect([a.kind, b.kind].sort()).toEqual(['answered', 'failed']);
    expect([a, b].find((o) => o.kind === 'failed')).toMatchObject({ reason: 'rate_limited' });
  });

  it('refuses new orders once today spend exceeds the cap, and never calls the supplier', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(1);
    const p = new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 100, dailySpendUsd: 10, costSince: async () => 10.05 });
    expect(await p.execute(req())).toMatchObject({ kind: 'failed', reason: 'spend_cap_reached' });
    expect(inner.calls).toBe(0);
  });

  it('polling is not blocked by the spend cap (it costs nothing)', async () => {
    const repos = new MemoryRepositories();
    class WithPoll extends Slow {
      pollCalls = 0;
      async poll(): Promise<ProviderOutcome> {
        this.pollCalls += 1;
        return { kind: 'answered', fields: [], misses: [] };
      }
    }
    const inner = new WithPoll(1);
    const p = new GuardedProvider(inner, {
      lock: repos.locks,
      lockWaitMs: 100,
      dailySpendUsd: 10,
      costSince: async () => 999,
    });
    const result = await p.poll?.('order-ref', service, AbortSignal.timeout(5000));
    expect(result).toMatchObject({ kind: 'answered' });
    expect(inner.pollCalls).toBe(1);
  });

  it('a waiter that times out does not break the queue: a third caller still acquires after the holder finishes', async () => {
    const repos = new MemoryRepositories();
    const events: string[] = [];
    const holderDone = repos.locks.withLock('n', 1000, async () => {
      events.push('holder-start');
      await new Promise((r) => setTimeout(r, 60));
      events.push('holder-end');
      return 'holder';
    });
    const timedOut = repos.locks.withLock('n', 10, async () => {
      events.push('waiter-ran');
      return 'waiter';
    });
    const [holderResult, waiterResult] = await Promise.all([holderDone, timedOut]);
    expect(holderResult).toEqual({ acquired: true, value: 'holder' });
    expect(waiterResult).toEqual({ acquired: false });
    expect(events).not.toContain('waiter-ran');

    const third = await repos.locks.withLock('n', 1000, async () => {
      events.push('third-ran');
      return 'third';
    });
    expect(third).toEqual({ acquired: true, value: 'third' });
    expect(events).toEqual(['holder-start', 'holder-end', 'third-ran']);
  });

  it('leaves poll undefined when the inner provider has no poll, so a caller can still tell "cannot poll" apart from "poll fails"', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(1); // Slow has no `poll` method
    const p = new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 100, dailySpendUsd: 10, costSince: async () => 0 });
    expect(p.poll).toBeUndefined();
  });

  it('forwards parseWebhook unlocked (it makes no supplier call), and leaves it undefined when the inner has none', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(1);
    expect(new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 100, dailySpendUsd: 10, costSince: async () => 0 }).parseWebhook).toBeUndefined();

    const parsed = { referenceId: 'r', outcome: { kind: 'answered', fields: [], misses: [] } } as const;
    const withHook = Object.assign(new Slow(1), { parseWebhook: async () => parsed });
    const p = new GuardedProvider(withHook, { lock: repos.locks, lockWaitMs: 100, dailySpendUsd: 10, costSince: async () => 0 });
    // A webhook is an inbound POST: taking the one-job lock for it would starve real calls.
    await repos.locks.withLock('provider:imei24', 1_000, async () => {
      expect(await p.parseWebhook?.({ headers: {}, rawBody: Buffer.alloc(0) })).toBe(parsed);
    });
  });
});
