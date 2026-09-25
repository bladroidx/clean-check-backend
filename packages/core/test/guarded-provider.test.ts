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
    expect([a, b].find((o) => o.kind === 'failed')).toMatchObject({ reason: 'rate_limited', notSent: true });
  });

  it('the caller signal bounds the lock WAIT, and an order is never placed after it aborted', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(1);
    const p = new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 5_000, dailySpendUsd: 10, costSince: async () => 0 });
    let release: () => void = () => {};
    // Another process (the worker) holds the lock for longer than our budget.
    const holder = repos.locks.withLock('provider:imei24', 1_000, () => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 5));

    const started = Date.now();
    const outcome = await p.execute(req(AbortSignal.timeout(50)));
    expect(Date.now() - started).toBeLessThan(1_000);
    // Refused while still waiting: provably never sent, so the router prices it at 0 (R18).
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'timeout', notSent: true });

    // The lock frees up later: the abandoned waiter must not run the call.
    release();
    await holder;
    await new Promise((r) => setTimeout(r, 20));
    expect(inner.calls).toBe(0);
  });

  it('refuses new orders once today spend exceeds the cap, and never calls the supplier', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(1);
    const p = new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 100, dailySpendUsd: 10, costSince: async () => 10.05 });
    expect(await p.execute(req())).toMatchObject({ kind: 'failed', reason: 'spend_cap_reached', notSent: true });
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

describe('GuardedProvider in-lock dedupe hooks (R17)', () => {
  const opts = (repos: MemoryRepositories) => ({ lock: repos.locks, lockWaitMs: 1_000, dailySpendUsd: 10, costSince: async () => 0 });

  it('runs beforeSend and afterSend while HOLDING the lock, around the supplier call', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(1);
    const p = new GuardedProvider(inner, opts(repos));
    const events: string[] = [];
    const lockFree = async () =>
      (await repos.locks.withLock('provider:imei24', 0, async () => undefined)).acquired;
    await p.execute({
      ...req(),
      inLock: {
        beforeSend: async () => { events.push(`before:${await lockFree() ? 'unlocked' : 'locked'}`); return undefined; },
        afterSend: async () => { events.push(`after:${await lockFree() ? 'unlocked' : 'locked'}:${inner.calls}`); },
      },
    });
    expect(events).toEqual(['before:locked', 'after:locked:1']);
  });

  it('an outcome from beforeSend is returned INSTEAD of calling the supplier', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(1);
    const p = new GuardedProvider(inner, opts(repos));
    const joined: ProviderOutcome = { kind: 'pending', orderReference: 'already-open', providerCostUsd: 0 };
    let after = 0;
    const outcome = await p.execute({ ...req(), inLock: { beforeSend: async () => joined, afterSend: async () => { after += 1; } } });
    expect(outcome).toBe(joined);
    expect(inner.calls).toBe(0);
    expect(after).toBe(0);
  });

  it('a failing re-check buys nothing; a failing persist still returns what was bought', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(1);
    const p = new GuardedProvider(inner, opts(repos));
    const refused = await p.execute({ ...req(), inLock: { beforeSend: async () => { throw new Error('db'); }, afterSend: async () => {} } });
    expect(refused).toMatchObject({ kind: 'failed', notSent: true });
    expect(inner.calls).toBe(0);

    const bought = await p.execute({ ...req(), inLock: { beforeSend: async () => undefined, afterSend: async () => { throw new Error('db'); } } });
    expect(bought).toMatchObject({ kind: 'answered' });
    expect(inner.calls).toBe(1);
  });
});
