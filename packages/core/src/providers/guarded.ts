import type {
  CatalogueService,
  ExecuteRequest,
  Provider,
  ProviderOutcome,
} from '@imei-check/providers';
import type { ProviderLock } from '../db/types.js';

/**
 * Wraps a supplier with the two guards imei24 needs and a router cannot express:
 *
 * 1. ONE call at a time per API key, across API and worker processes (imei24: "You can do ONE JOB
 *    in time"). Every call -- place, poll, balance -- holds the lock for one HTTP request only.
 * 2. A daily spend cap on NEW orders. imei24 charges again for every repeat, so a bug or a leaked
 *    service key would otherwise spend without limit. Polling is free and never capped.
 *
 * Both refusals are `failed`, never a field: nothing here can make a section pass.
 */
export interface GuardOptions {
  readonly lock: ProviderLock;
  readonly lockWaitMs: number;
  readonly dailySpendUsd: number;
  readonly costSince: (providerId: string, since: Date) => Promise<number>;
  readonly now?: () => Date;
}

export class GuardedProvider implements Provider {
  readonly id: string;

  constructor(
    private readonly inner: Provider,
    private readonly options: GuardOptions,
  ) {
    this.id = inner.id;
  }

  catalogue(): readonly CatalogueService[] {
    return this.inner.catalogue();
  }

  supports(capability: Parameters<Provider['supports']>[0], tac: string): CatalogueService | undefined {
    return this.inner.supports(capability, tac);
  }

  async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
    const now = (this.options.now ?? (() => new Date()))();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // The router wrote this call's own provider_calls row BEFORE execute, so `spent` already
    // includes it: exceeding means this call is the one that would cross the line.
    const spent = await this.options.costSince(this.id, dayStart);
    if (spent > this.options.dailySpendUsd) {
      return { kind: 'failed', reason: 'spend_cap_reached', detail: 'daily supplier spend cap reached' };
    }
    return this.locked(() => this.inner.execute(request));
  }

  async poll(orderReference: string, service: CatalogueService, signal: AbortSignal): Promise<ProviderOutcome> {
    const innerPoll = this.inner.poll;
    if (innerPoll === undefined) {
      return { kind: 'failed', reason: 'transport_error', detail: 'provider cannot poll' };
    }
    return this.locked(() => innerPoll.call(this.inner, orderReference, service, signal));
  }

  async health(signal: AbortSignal): Promise<{ balanceUsd?: number; reachable: boolean }> {
    const innerHealth = this.inner.health;
    if (innerHealth === undefined) return { reachable: false };
    const result = await this.options.lock.withLock(`provider:${this.id}`, this.options.lockWaitMs, () =>
      innerHealth.call(this.inner, signal),
    );
    return result.acquired ? result.value : { reachable: true };
  }

  private async locked(fn: () => Promise<ProviderOutcome>): Promise<ProviderOutcome> {
    const result = await this.options.lock.withLock(`provider:${this.id}`, this.options.lockWaitMs, fn);
    return result.acquired
      ? result.value
      : { kind: 'failed', reason: 'rate_limited', detail: 'supplier is busy with another job' };
  }
}
