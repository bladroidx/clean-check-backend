import { randomUUID } from 'node:crypto';
import type { Capability } from '@imei-check/contract';
import type { BreakerRegistry } from './breaker.js';
import type { CatalogueService, Provider, ProviderOutcome } from './types.js';

/**
 * Picks a provider, runs it, and decides whether to try another.
 *
 * **The rule this file exists for: fail over on transport failure or an open circuit only —
 * never after a definite negative answer.**
 *
 * If provider A says "blacklisted" and we ask provider B hoping for something nicer, then a
 * reseller holding an API key retries until one says clean and we have built a laundering service.
 * The same logic applies to a `rejected`: the supplier answered, and asking a second one costs
 * money to be told the same thing.
 *
 * So exactly one outcome kind continues the loop — `failed` — and the test that proves it is
 * `router.test.ts:"does not fail over after a fail outcome"`.
 */

export interface Attempt {
  readonly attemptId: string;
  readonly providerId: string;
  readonly serviceId: string;
  readonly capability: Capability;
  readonly outcome: ProviderOutcome;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly latencyMs: number;
  /**
   * A failover leg is absorbed, not charged. The tenant asked one question; that we had to ask
   * twice is our supply chain's problem and our cost of doing business.
   */
  readonly billable: boolean;
  readonly costUsd: number;
}

export interface RouteResult {
  readonly capability: Capability;
  /** Every leg, in order. The last one is the answer; the rest are absorbed cost. */
  readonly attempts: readonly Attempt[];
  readonly outcome: ProviderOutcome;
  /** Undefined when no configured provider covers this capability for this device at all. */
  readonly service: CatalogueService | undefined;
}

export interface RouterHooks {
  /**
   * Called BEFORE the HTTP request, always.
   *
   * A timeout arriving after the supplier already debited us is the common case, so the row that
   * says "we spent money" must exist before the money can be spent. Recording on success only puts
   * the books permanently behind reality.
   */
  onCallStart?(attempt: {
    attemptId: string;
    providerId: string;
    serviceId: string;
    capability: Capability;
    costUsd: number;
  }): Promise<void> | void;
  onCallFinish?(attempt: Attempt): Promise<void> | void;
}

export interface RouterOptions {
  readonly providers: readonly Provider[];
  readonly breakers: BreakerRegistry;
  readonly hooks?: RouterHooks;
  readonly now?: () => Date;
  readonly feedbackUrlFor?: (providerId: string) => string | undefined;
}

export class Router {
  constructor(private readonly options: RouterOptions) {}

  /** Ordered candidates: catalogue order is the preference order, cheapest-first by convention. */
  candidates(capability: Capability, tac: string): Array<{ provider: Provider; service: CatalogueService }> {
    const found: Array<{ provider: Provider; service: CatalogueService }> = [];
    for (const provider of this.options.providers) {
      const service = provider.supports(capability, tac);
      if (service !== undefined) found.push({ provider, service });
    }
    return found.sort((a, b) => a.service.costUsd - b.service.costUsd);
  }

  async run(args: {
    capability: Capability;
    tac: string;
    imeiDigits: string;
    signal: AbortSignal;
  }): Promise<RouteResult> {
    const now = this.options.now ?? (() => new Date());
    const candidates = this.candidates(args.capability, args.tac);

    if (candidates.length === 0) {
      return {
        capability: args.capability,
        attempts: [],
        service: undefined,
        // Distinct from a transport failure: nothing was tried and nothing is wrong upstream. It
        // is a gap in OUR supply, and a dashboard that cannot tell the two apart will read a
        // missing catalogue entry as a supplier outage.
        outcome: {
          kind: 'failed',
          reason: 'no_provider_configured',
          detail: 'No data source is configured for this check.',
        },
      };
    }

    const attempts: Attempt[] = [];
    let last: ProviderOutcome = {
      kind: 'failed',
      reason: 'transport_error',
      detail: 'no attempt was made',
    };
    let lastService: CatalogueService | undefined;

    for (const [index, candidate] of candidates.entries()) {
      const breaker = this.options.breakers.get(candidate.provider.id);
      lastService = candidate.service;

      if (breaker.isOpen()) {
        // An open circuit is a reason to move on, and if nobody is left it is the answer:
        // `unavailable(circuit_open)`, never a pass.
        last = { kind: 'failed', reason: 'circuit_open', detail: `${candidate.provider.id} circuit is open` };
        continue;
      }

      const attemptId = randomUUID();
      const startedAt = now();

      await this.options.hooks?.onCallStart?.({
        attemptId,
        providerId: candidate.provider.id,
        serviceId: candidate.service.serviceId,
        capability: args.capability,
        costUsd: candidate.service.costUsd,
      });

      const outcome = await this.execute(candidate, args, attemptId);
      const finishedAt = now();

      if (outcome.kind === 'failed') breaker.recordFailure();
      else breaker.recordSuccess();

      const attempt: Attempt = {
        attemptId,
        providerId: candidate.provider.id,
        serviceId: candidate.service.serviceId,
        capability: args.capability,
        outcome,
        startedAt,
        finishedAt,
        latencyMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        // Only the leg that produced the answer is billable, and only if it is not a failure.
        billable: outcome.kind !== 'failed',
        costUsd: outcome.kind === 'failed' ? 0 : candidate.service.costUsd,
      };
      attempts.push(attempt);
      await this.options.hooks?.onCallFinish?.(attempt);

      last = outcome;

      // THE RULE. Anything that is not a transport failure ends the loop, whatever it says.
      if (outcome.kind !== 'failed') break;

      void index;
    }

    return { capability: args.capability, attempts, outcome: last, service: lastService };
  }

  private async execute(
    candidate: { provider: Provider; service: CatalogueService },
    args: { capability: Capability; imeiDigits: string; signal: AbortSignal },
    referenceId: string,
  ): Promise<ProviderOutcome> {
    const timeout = AbortSignal.timeout(candidate.service.timeoutMs);
    const signal = AbortSignal.any([args.signal, timeout]);
    const feedbackUrl = this.options.feedbackUrlFor?.(candidate.provider.id);

    try {
      return await candidate.provider.execute({
        capability: args.capability,
        service: candidate.service,
        imeiDigits: args.imeiDigits,
        signal,
        referenceId,
        ...(feedbackUrl !== undefined ? { feedbackUrl } : {}),
      });
    } catch {
      // An adapter that throws is a bug in the adapter, and it must not take the check down.
      return { kind: 'failed', reason: 'transport_error', detail: 'provider adapter threw' };
    }
  }
}
