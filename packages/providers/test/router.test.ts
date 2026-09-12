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
