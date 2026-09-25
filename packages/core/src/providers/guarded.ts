import type {
  CatalogueService,
  ExecuteRequest,
  ParsedWebhook,
  Provider,
  ProviderOutcome,
  WebhookInput,
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

  // `poll` and `health` are assigned conditionally in the constructor, not declared as methods
  // that delegate-or-fail. A caller checks `provider.poll === undefined` to mean "this provider
  // cannot poll at all" (Task 3's router does this). If this class always defined `poll`, wrapping
  // a poll-less provider would turn that into "poll always fails" -- a different, worse thing than
  // "cannot poll" -- and the router would keep a dead candidate in its list instead of skipping it.
  readonly poll?: (
    orderReference: string,
    service: CatalogueService,
    signal: AbortSignal,
  ) => Promise<ProviderOutcome>;
  readonly health?: (signal: AbortSignal) => Promise<{ balanceUsd?: number; reachable: boolean }>;
  /** Unlocked: parsing an inbound webhook makes no call to the supplier. Same conditional rule. */
  readonly parseWebhook?: (input: WebhookInput) => Promise<ParsedWebhook>;

  constructor(
    private readonly inner: Provider,
    private readonly options: GuardOptions,
  ) {
    this.id = inner.id;

    const innerPoll = inner.poll;
    if (innerPoll !== undefined) {
      this.poll = (orderReference, service, signal) =>
        this.locked(() => innerPoll.call(inner, orderReference, service, signal), signal);
    }

    const innerParse = inner.parseWebhook;
    if (innerParse !== undefined) {
      this.parseWebhook = (input) => innerParse.call(inner, input);
    }

    const innerHealth = inner.health;
    if (innerHealth !== undefined) {
      this.health = async (signal) => {
        const result = await this.options.lock.withLock(`provider:${this.id}`, this.options.lockWaitMs, () =>
          innerHealth.call(inner, signal),
        );
        return result.acquired ? result.value : { reachable: true };
      };
    }
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
    return this.locked(() => this.inner.execute(request), request.signal);
  }

  /**
   * Holds the lock for one call. The caller's `signal` bounds the WAIT as well as the call: a
   * deep check whose budget runs out while the worker holds the lock returns at once rather than
   * sitting out `lockWaitMs`. If the lock is granted later anyway, `fn` is skipped -- an order
   * placed after the caller gave up is money spent on an answer nobody will receive.
   */
  private async locked(fn: () => Promise<ProviderOutcome>, signal?: AbortSignal): Promise<ProviderOutcome> {
    if (signal?.aborted === true) return BUDGET_SPENT;
    const state = { started: false };
    const attempt = this.options.lock.withLock(`provider:${this.id}`, this.options.lockWaitMs, () => {
      if (signal?.aborted === true) return Promise.resolve(BUDGET_SPENT);
      state.started = true;
      return fn();
    });
    const result = signal === undefined ? await attempt : await raceAbort(attempt, signal, state);
    return result.acquired
      ? result.value
      : { kind: 'failed', reason: 'rate_limited', detail: 'supplier is busy with another job' };
  }
}

const BUDGET_SPENT: ProviderOutcome = {
  kind: 'failed',
  reason: 'timeout',
  detail: 'The time budget was spent before the supplier was free.',
};

type LockResult = { readonly acquired: true; readonly value: ProviderOutcome } | { readonly acquired: false };

/**
 * Resolves with the lock result, or with `BUDGET_SPENT` if `signal` aborts while still WAITING
 * for the lock. Once the call has started it is never abandoned here: the supplier call gets the
 * same signal and returns promptly itself, and walking away from a call that may already have
 * placed an order would lose the order reference we paid for.
 */
function raceAbort(
  attempt: Promise<LockResult>,
  signal: AbortSignal,
  state: { readonly started: boolean },
): Promise<LockResult> {
  return new Promise<LockResult>((resolve, reject) => {
    const onAbort = () => {
      if (!state.started) resolve({ acquired: true, value: BUDGET_SPENT });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    attempt.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
