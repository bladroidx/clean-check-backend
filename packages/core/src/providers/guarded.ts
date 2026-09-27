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
 * Wraps a supplier with the guards imei24 needs and a router cannot express:
 *
 * 1. ONE call at a time per API key, across API and worker processes (imei24: "You can do ONE JOB
 *    in time"). Every call -- place, poll, balance -- holds the lock for one HTTP request only.
 * 2. A daily spend cap on NEW orders. imei24 charges again for every repeat, so a bug or a leaked
 *    service key would otherwise spend without limit. Polling is free and never capped.
 * 3. No purchase of a service the catalogue drift job has switched off (the supplier's live price
 *    rose above the one the spend cap sums, or the service left their list). Checked per call
 *    against the database, so the API and the worker see an override the moment it is written.
 *
 * Both refusals are `failed`, never a field: nothing here can make a section pass.
 */
export interface GuardOptions {
  readonly lock: ProviderLock;
  readonly lockWaitMs: number;
  readonly dailySpendUsd: number;
  readonly costSince: (providerId: string, since: Date) => Promise<number>;
  /** The drift job's runtime overrides. Omitted means nothing is ever disabled (tests). */
  readonly isDisabled?: (providerId: string, serviceId: string) => Promise<boolean>;
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
  readonly servicePrices?: (signal: AbortSignal) => Promise<ReadonlyMap<string, number> | undefined>;
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

    const innerPrices = inner.servicePrices;
    if (innerPrices !== undefined) {
      // Busy lock = "could not read the list", never an empty list (see Provider.servicePrices).
      this.servicePrices = async (signal) => {
        const result = await this.options.lock.withLock(`provider:${this.id}`, this.options.lockWaitMs, () =>
          innerPrices.call(inner, signal),
        );
        return result.acquired ? result.value : undefined;
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
    if (this.options.isDisabled !== undefined) {
      let disabled: boolean;
      try {
        disabled = await this.options.isDisabled(this.id, request.service.serviceId);
      } catch {
        // Cannot tell whether the price is still the one we sum: do not buy. Reported as our own
        // refusal (`service_disabled`), not a transport error -- a database hiccup here must not
        // count toward opening the supplier's circuit breaker.
        return {
          kind: 'failed',
          reason: 'service_disabled',
          detail: 'could not check whether this service is disabled',
          notSent: true,
        };
      }
      if (disabled) {
        return {
          kind: 'failed',
          reason: 'service_disabled',
          detail: 'service disabled after a supplier price change',
          notSent: true,
        };
      }
    }
    const now = (this.options.now ?? (() => new Date()))();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // The router wrote this call's own provider_calls row BEFORE execute, so `spent` already
    // includes it: exceeding means this call is the one that would cross the line.
    const spent = await this.options.costSince(this.id, dayStart);
    if (spent > this.options.dailySpendUsd) {
      return {
        kind: 'failed',
        reason: 'spend_cap_reached',
        detail: 'daily supplier spend cap reached',
        notSent: true,
      };
    }
    const hooks = request.inLock;
    if (hooks === undefined) return this.locked(() => this.inner.execute(request), request.signal);
    return this.locked(async () => {
      // Final review F2 / R17: the caller's attach-or-cache check ran BEFORE this lock, so another
      // check for the same device may have bought the answer while we queued. Ask again now that
      // nobody else can be mid-purchase.
      let deduped: ProviderOutcome | undefined;
      try {
        deduped = await hooks.beforeSend();
      } catch {
        // Cannot tell whether it is already bought: do not buy it (possibly) twice.
        return {
          kind: 'failed',
          reason: 'transport_error',
          detail: 'could not check for an order already in flight',
          notSent: true,
        };
      }
      if (deduped !== undefined) return deduped;

      const outcome = await this.inner.execute(request);
      try {
        // Persist BEFORE the lock is released, so the next holder's re-check sees it.
        await hooks.afterSend(outcome);
      } catch {
        // The purchase happened; losing it here would lose the order reference we paid for. The
        // caller persists again after the call when this did not complete.
      }
      return outcome;
    }, request.signal);
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
      : // Our own lock was busy: the request never left, so it is priced at zero (R18).
        { kind: 'failed', reason: 'rate_limited', detail: 'supplier is busy with another job', notSent: true };
  }
}

/** Refused while still waiting for the lock -- never sent, so never spend (R18). */
const BUDGET_SPENT: ProviderOutcome = {
  kind: 'failed',
  reason: 'timeout',
  detail: 'The time budget was spent before the supplier was free.',
  notSent: true,
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
