import { describe, expect, it } from 'vitest';
import { BreakerRegistry, CircuitBreaker } from '../src/breaker.js';
import { Router } from '../src/router.js';
import type { CatalogueService, ExecuteRequest, Provider, ProviderOutcome } from '../src/types.js';

/**
 * Routing and failover.
 *
 * The rule under test is the one that separates an aggregator from a laundering service:
 *
 *   **Fail over on transport failure or an open circuit only -- never after a definite answer.**
 *
 * If provider A says "blacklisted" and we ask provider B hoping for something nicer, a reseller
 * with an API key simply retries until one says clean.
 */

function service(overrides: Partial<CatalogueService> = {}): CatalogueService {
  return {
    serviceId: 's1',
    providerId: 'p',
    displayName: 's',
    capabilities: ['blacklist.gsma'],
    fields: ['blacklist.status'],
    lexiconId: 'blacklist',
    costUsd: 0.1,
    credits: 3,
    async: false,
    timeoutMs: 5000,
    appliesToTacPrefixes: ['*'],
    enabled: true,
    ...overrides,
  };
}

class FakeProvider implements Provider {
  readonly calls: string[] = [];
  constructor(
    readonly id: string,
    private readonly outcome: ProviderOutcome,
    private readonly svc: CatalogueService = service(),
  ) {}
  catalogue(): readonly CatalogueService[] {
    return [this.svc];
  }
  supports(): CatalogueService | undefined {
    return this.svc;
  }
  async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
    this.calls.push(request.referenceId);
    return this.outcome;
  }
}

const BLOCKED: ProviderOutcome = {
  kind: 'answered',
  fields: [{ field: 'blacklist.status', value: 'blocked' }],
  misses: [],
};
const CLEAN: ProviderOutcome = {
  kind: 'answered',
  fields: [{ field: 'blacklist.status', value: 'clean' }],
  misses: [],
};
const FAILED: ProviderOutcome = { kind: 'failed', reason: 'timeout' };

function run(providers: Provider[], breakers = new BreakerRegistry()) {
  const router = new Router({ providers, breakers });
  return router.run({
    capability: 'blacklist.gsma',
    tac: '35310411',
    imeiDigits: '353104112345676',
    signal: AbortSignal.timeout(10_000),
  });
}

describe('failover', () => {
  /** The fraud vector, as a test. */
  it('does NOT ask a second provider after a definite "blocked"', async () => {
    const a = new FakeProvider('a', BLOCKED, service({ providerId: 'a', costUsd: 0.1 }));
    const b = new FakeProvider('b', CLEAN, service({ providerId: 'b', costUsd: 0.2 }));

    const result = await run([a, b]);

    expect(b.calls).toEqual([]);
    expect(result.attempts).toHaveLength(1);
    expect(result.outcome).toEqual(BLOCKED);
  });

  it('does not fail over after a rejection either', async () => {
    const a = new FakeProvider(
      'a',
      { kind: 'rejected', reason: 'device_not_supported' },
      service({ providerId: 'a', costUsd: 0.1 }),
    );
    const b = new FakeProvider('b', CLEAN, service({ providerId: 'b', costUsd: 0.2 }));

    await run([a, b]);

    // Asking a second supplier because the first said "this TAC is not an Apple device" spends
    // money to be told the same thing.
    expect(b.calls).toEqual([]);
  });

  it('does not fail over after a pending order', async () => {
    const a = new FakeProvider(
      'a',
      { kind: 'pending', orderReference: 'o1' },
      service({ providerId: 'a', costUsd: 0.1 }),
    );
    const b = new FakeProvider('b', CLEAN, service({ providerId: 'b', costUsd: 0.2 }));

    await run([a, b]);
    expect(b.calls).toEqual([]);
  });

  it('DOES fail over on a transport failure', async () => {
    const a = new FakeProvider('a', FAILED, service({ providerId: 'a', costUsd: 0.1 }));
    const b = new FakeProvider('b', CLEAN, service({ providerId: 'b', costUsd: 0.2 }));

    const result = await run([a, b]);

    expect(b.calls).toHaveLength(1);
    expect(result.outcome).toEqual(CLEAN);
    expect(result.attempts).toHaveLength(2);
  });

  it('marks the failover leg as absorbed cost, not billable', async () => {
    const a = new FakeProvider('a', FAILED, service({ providerId: 'a', costUsd: 0.1 }));
    const b = new FakeProvider('b', CLEAN, service({ providerId: 'b', costUsd: 0.2 }));

    const result = await run([a, b]);

    // The tenant asked one question. That we had to ask twice is our supply chain's problem.
    expect(result.attempts[0]?.billable).toBe(false);
    expect(result.attempts[1]?.billable).toBe(true);
  });

  it('tries the cheapest provider first', async () => {
    const dear = new FakeProvider('dear', CLEAN, service({ providerId: 'dear', costUsd: 0.9 }));
    const cheap = new FakeProvider('cheap', CLEAN, service({ providerId: 'cheap', costUsd: 0.1 }));

    const result = await run([dear, cheap]);
    expect(result.attempts[0]?.providerId).toBe('cheap');
    expect(dear.calls).toEqual([]);
  });

  it('reports failed, never a pass, when every provider fails', async () => {
    const a = new FakeProvider('a', FAILED, service({ providerId: 'a', costUsd: 0.1 }));
    const b = new FakeProvider('b', FAILED, service({ providerId: 'b', costUsd: 0.2 }));

    const result = await run([a, b]);
    expect(result.outcome.kind).toBe('failed');
  });

  it('reports failed when no provider covers the capability at all', async () => {
    const result = await run([]);
    expect(result.outcome.kind).toBe('failed');
    expect(result.attempts).toEqual([]);
  });

  it('skips a provider whose circuit is open and uses the next one', async () => {
    const breakers = new BreakerRegistry();
    const open = breakers.get('a');
    for (let i = 0; i < 5; i += 1) open.recordFailure();
    expect(open.isOpen()).toBe(true);

    const a = new FakeProvider('a', CLEAN, service({ providerId: 'a', costUsd: 0.1 }));
    const b = new FakeProvider('b', CLEAN, service({ providerId: 'b', costUsd: 0.2 }));

    const result = await run([a, b], breakers);
    expect(a.calls).toEqual([]);
    expect(result.outcome).toEqual(CLEAN);
  });

  it('does not count our own lock or spend-cap refusals against the supplier breaker', async () => {
    for (const reason of ['rate_limited', 'spend_cap_reached'] as const) {
      const breakers = new BreakerRegistry();
      const refused = new FakeProvider('a', { kind: 'failed', reason, detail: 'ours' });
      for (let i = 0; i < 10; i += 1) {
        const result = await run([refused], breakers);
        // Still a failure -- no field, never a pass -- just not the supplier's failure.
        expect(result.outcome.kind).toBe('failed');
      }
      expect(breakers.get('a').isOpen()).toBe(false);
    }
    // Control: the same count of genuine supplier failures does open it.
    const breakers = new BreakerRegistry();
    for (let i = 0; i < 10; i += 1) await run([new FakeProvider('a', FAILED)], breakers);
    expect(breakers.get('a').isOpen()).toBe(true);
  });

  it('places nothing, and writes no provider_calls row, once the caller signal has aborted', async () => {
    const started: string[] = [];
    const a = new FakeProvider('a', CLEAN);
    const router = new Router({
      providers: [a],
      breakers: new BreakerRegistry(),
      hooks: { onCallStart: (x) => void started.push(x.attemptId) },
    });
    const { calls } = router.plan(['blacklist.gsma'], '35310411');
    const call = calls[0];
    if (call === undefined) throw new Error('expected a planned call');
    const result = await router.runCall({ call, imeiDigits: 'x', signal: AbortSignal.abort() });
    expect(a.calls).toEqual([]);
    expect(started).toEqual([]);
    expect(result.outcome.kind).toBe('failed');
  });

  it('a failure after the caller signal aborted is ours, not the supplier breaker', async () => {
    const breakers = new BreakerRegistry();
    let controller = new AbortController();
    // Aborts mid-call, as the deep-check budget does.
    class AbortsMidCall extends FakeProvider {
      override async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
        controller.abort();
        return super.execute(request);
      }
    }
    const provider = new AbortsMidCall('a', FAILED);
    const router = new Router({ providers: [provider], breakers });
    for (let i = 0; i < 10; i += 1) {
      controller = new AbortController();
      const { calls } = router.plan(['blacklist.gsma'], '35310411');
      const call = calls[0];
      if (call === undefined) throw new Error('expected a planned call');
      await router.runCall({ call, imeiDigits: 'x', signal: controller.signal });
    }
    expect(provider.calls).toHaveLength(10);
    expect(breakers.get('a').isOpen()).toBe(false);
  });

  it('records provider_calls BEFORE the request is made', async () => {
    const order: string[] = [];
    const provider: Provider = {
      id: 'a',
      catalogue: () => [service()],
      supports: () => service(),
      async execute() {
        order.push('http');
        return CLEAN;
      },
    };
    const router = new Router({
      providers: [provider],
      breakers: new BreakerRegistry(),
      hooks: {
        onCallStart() {
          order.push('row');
        },
      },
    });
    await router.run({
      capability: 'blacklist.gsma',
      tac: '35310411',
      imeiDigits: '353104112345676',
      signal: AbortSignal.timeout(5000),
    });
    // A timeout arriving after the supplier already debited us is the common case.
    expect(order).toEqual(['row', 'http']);
  });

  it('survives an adapter that throws', async () => {
    const provider: Provider = {
      id: 'a',
      catalogue: () => [service()],
      supports: () => service(),
      async execute() {
        throw new Error('adapter bug');
      },
    };
    const result = await run([provider]);
    expect(result.outcome.kind).toBe('failed');
  });
});

describe('plan / runCall', () => {
  const wild = service({ serviceId: '486', capabilities: ['blacklist.gsma'], appliesToTacPrefixes: ['*'], costUsd: 0.1 });
  const apple = service({
    serviceId: '690',
    capabilities: ['blacklist.gsma', 'lock.activation', 'lock.carrier', 'warranty.purchase_date'],
    fields: ['blacklist.status', 'lock.activation.status', 'lock.carrier.status', 'warranty.purchase_date'],
    appliesToTacPrefixes: ['353104'],
    costUsd: 0.12,
  });

  class MultiServiceProvider implements Provider {
    readonly executed: string[] = [];
    constructor(
      readonly id: string,
      private readonly services: CatalogueService[],
      private readonly outcome: ProviderOutcome = CLEAN,
    ) {}
    catalogue(): readonly CatalogueService[] {
      return this.services;
    }
    supports(capability: string, tac: string): CatalogueService | undefined {
      return this.services.find(
        (s) =>
          (s.capabilities as readonly string[]).includes(capability) &&
          s.appliesToTacPrefixes.some((p) => p === '*' || tac.startsWith(p)),
      );
    }
    async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
      this.executed.push(request.referenceId);
      return this.outcome;
    }
  }

  function routerWith(services: CatalogueService[]): Router {
    return new Router({ providers: [new MultiServiceProvider('p', services)], breakers: new BreakerRegistry() });
  }

  function fakeProvider(services: CatalogueService[], outcome: ProviderOutcome): MultiServiceProvider {
    return new MultiServiceProvider('p', services, outcome);
  }

  it('one Apple service covers four capabilities in ONE call', () => {
    const router = routerWith([wild, apple]);
    const { calls, uncovered } = router.plan(
      ['blacklist.gsma', 'lock.activation', 'lock.carrier', 'warranty.purchase_date'],
      '35310411',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.candidates[0]?.service.serviceId).toBe('690');
    expect(uncovered).toEqual([]);
  });

  it('brand-specific beats cheaper wildcard for the same capability', () => {
    const router = routerWith([wild, { ...apple, costUsd: 0.5 }]);
    const { calls } = router.plan(['blacklist.gsma'], '35310411');
    expect(calls[0]?.candidates.map((c) => c.service.serviceId)).toEqual(['690', '486']);
  });

  it('an unknown TAC falls back to the wildcard and reports the rest as uncovered', () => {
    const router = routerWith([wild, apple]);
    const { calls, uncovered } = router.plan(['blacklist.gsma', 'lock.activation'], '99999999');
    expect(calls.map((c) => c.candidates[0]?.service.serviceId)).toEqual(['486']);
    expect(uncovered).toEqual(['lock.activation']);
  });

  it('runCall executes once for a multi-capability service', async () => {
    const provider = fakeProvider([wild, apple], { kind: 'answered', fields: [], misses: [] });
    const router = new Router({ providers: [provider], breakers: new BreakerRegistry() });
    const { calls } = router.plan(['blacklist.gsma', 'lock.activation'], '35310411');
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('unreachable');
    await router.runCall({ call, imeiDigits: 'x', signal: AbortSignal.timeout(1000) });
    expect(provider.executed).toHaveLength(1);
  });

  const appleByBrand = service({
    serviceId: '690',
    capabilities: ['blacklist.gsma', 'lock.activation', 'lock.carrier', 'warranty.purchase_date'],
    fields: ['blacklist.status', 'lock.activation.status', 'lock.carrier.status', 'warranty.purchase_date'],
    appliesToTacPrefixes: ['*'],
    appliesToManufacturers: ['apple'],
    costUsd: 0.12,
  });
  const samsungByBrand = service({
    serviceId: '783',
    capabilities: ['blacklist.gsma', 'warranty.purchase_date'],
    fields: ['blacklist.status', 'warranty.purchase_date'],
    appliesToTacPrefixes: ['*'],
    appliesToManufacturers: ['samsung'],
    costUsd: 0.1,
  });

  function routerWithManufacturerServices(services: CatalogueService[]): Router {
    return new Router({ providers: [new MultiServiceProvider('p', services)], breakers: new BreakerRegistry() });
  }

  it('an Apple manufacturer chooses the brand-restricted service for all four capabilities in one call', () => {
    const router = routerWithManufacturerServices([wild, appleByBrand]);
    const { calls, uncovered } = router.plan(
      ['blacklist.gsma', 'lock.activation', 'lock.carrier', 'warranty.purchase_date'],
      '00000000',
      'Apple',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.candidates[0]?.service.serviceId).toBe('690');
    expect(uncovered).toEqual([]);
  });

  it('an unknown manufacturer (undefined) only gets the unrestricted wildcard; brand-only capabilities are uncovered', () => {
    const router = routerWithManufacturerServices([wild, appleByBrand]);
    const { calls, uncovered } = router.plan(['blacklist.gsma', 'lock.activation'], '00000000', undefined);
    expect(calls.map((c) => c.candidates[0]?.service.serviceId)).toEqual(['486']);
    expect(uncovered).toEqual(['lock.activation']);
  });

  it('manufacturer match is case-insensitive ("Samsung" matches "samsung")', () => {
    const router = routerWithManufacturerServices([wild, samsungByBrand]);
    const { calls } = router.plan(['blacklist.gsma'], '00000000', 'Samsung');
    expect(calls[0]?.candidates.map((c) => c.service.serviceId)).toEqual(['783', '486']);
  });
});

describe('circuit breaker', () => {
  it('opens after the threshold and reports open', () => {
    let now = 1000;
    const breaker = new CircuitBreaker('p', {
      failureThreshold: 3,
      openMs: 1000,
      halfOpenSuccesses: 1,
      now: () => now,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');

    now += 1001;
    expect(breaker.state()).toBe('half_open');
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
  });

  it('a failed half-open probe restarts the full window rather than retrying at once', () => {
    let now = 1000;
    const breaker = new CircuitBreaker('p', {
      failureThreshold: 1,
      openMs: 1000,
      halfOpenSuccesses: 1,
      now: () => now,
    });
    breaker.recordFailure();
    now += 1001;
    expect(breaker.state()).toBe('half_open');
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
  });

  it('a success resets the consecutive count', () => {
    const breaker = new CircuitBreaker('p', {
      failureThreshold: 3,
      openMs: 1000,
      halfOpenSuccesses: 1,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });
});

/**
 * Final review F3 / ruling R18: a failed attempt that may have reached the supplier is spend.
 *
 * imei24 debits on placement. A timeout (or a 5xx, or a reply we could not parse) arriving after
 * the request left us is the COMMON case of a debit we got nothing for -- recording it at 0 makes
 * the daily spend cap undercount exactly when the supplier is misbehaving. And because the order
 * may exist, asking ANOTHER service of the same supplier for the same thing pays twice.
 */
describe('failed attempts: spend and same-provider failover (R18)', () => {
  class Scripted implements Provider {
    readonly executed: string[] = [];
    constructor(
      readonly id: string,
      private readonly services: CatalogueService[],
      private readonly outcomes: ProviderOutcome[],
    ) {}
    catalogue(): readonly CatalogueService[] {
      return this.services;
    }
    supports(): CatalogueService | undefined {
      return this.services[0];
    }
    async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
      this.executed.push(request.service.serviceId);
      return this.outcomes.length > 1 ? this.outcomes.shift()! : this.outcomes[0]!;
    }
  }

  const brand = service({ serviceId: '690', costUsd: 0.12, appliesToManufacturers: ['apple'] });
  const wildcard = service({ serviceId: '486', costUsd: 0.1 });

  async function runOne(providers: Provider[]) {
    const finished: Array<{ serviceId: string; costUsd: number }> = [];
    const router = new Router({
      providers,
      breakers: new BreakerRegistry(),
      hooks: { onCallFinish: (a) => void finished.push({ serviceId: a.serviceId, costUsd: a.costUsd }) },
    });
    const { calls } = router.plan(['blacklist.gsma'], '35310411', 'apple');
    const call = calls[0];
    if (call === undefined) throw new Error('expected a planned call');
    const result = await router.runCall({ call, imeiDigits: 'x', signal: AbortSignal.timeout(5_000) });
    return { result, finished };
  }

  it('a failure after the request may have been sent keeps its catalogue cost', async () => {
    for (const reason of ['timeout', 'http_error', 'malformed_response', 'transport_error'] as const) {
      const p = new Scripted('p', [wildcard], [{ kind: 'failed', reason }]);
      const { result, finished } = await runOne([p]);
      expect(result.attempts[0]?.costUsd).toBe(0.1);
      // The provider_calls row is finished with the same number the spend cap sums.
      expect(finished).toEqual([{ serviceId: '486', costUsd: 0.1 }]);
    }
  });

  it('a failure that provably never left us costs nothing', async () => {
    const neverSent: ProviderOutcome[] = [
      { kind: 'failed', reason: 'spend_cap_reached' },
      { kind: 'failed', reason: 'rate_limited', notSent: true },
      { kind: 'failed', reason: 'timeout', notSent: true },
    ];
    for (const outcome of neverSent) {
      const p = new Scripted('p', [wildcard], [outcome]);
      const { result } = await runOne([p]);
      expect(result.attempts[0]?.costUsd).toBe(0);
    }
  });

  it('never fails over to another service of the SAME provider after a possibly-sent failure', async () => {
    const p = new Scripted('p', [brand, wildcard], [{ kind: 'failed', reason: 'timeout' }, CLEAN]);
    const { result } = await runOne([p]);
    expect(p.executed).toEqual(['690']);
    expect(result.outcome.kind).toBe('failed');
  });

  it('still fails over to ANOTHER provider after a timeout', async () => {
    const p = new Scripted('p', [brand], [{ kind: 'failed', reason: 'timeout' }]);
    const q = new Scripted('q', [service({ providerId: 'q', serviceId: 'q1', costUsd: 0.2 })], [CLEAN]);
    const { result } = await runOne([p, q]);
    expect(q.executed).toEqual(['q1']);
    expect(result.outcome).toEqual(CLEAN);
  });

  it('may retry the same provider after rate_limited or a never-sent failure', async () => {
    for (const first of [
      { kind: 'failed', reason: 'rate_limited' },
      { kind: 'failed', reason: 'timeout', notSent: true },
    ] as const) {
      const p = new Scripted('p', [brand, wildcard], [first, CLEAN]);
      const { result } = await runOne([p]);
      expect(p.executed).toEqual(['690', '486']);
      expect(result.outcome).toEqual(CLEAN);
    }
  });
});
