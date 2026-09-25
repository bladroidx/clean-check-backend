import { randomUUID } from 'node:crypto';
import type { Capability } from '@imei-check/contract';
import type { BreakerRegistry } from './breaker.js';
import { coversDevice } from './catalogue.js';
import type { CatalogueService, FailureReason, Provider, ProviderOutcome } from './types.js';

/**
 * One purchase to make: the capabilities it will answer, and the candidate services (this one plus
 * its failover chain) ranked brand-specific-first-then-cheapest.
 */
export interface PlannedCall {
  readonly capabilities: readonly Capability[];
  readonly candidates: ReadonlyArray<{ provider: Provider; service: CatalogueService }>;
}

/**
 * A service is brand-specific -- specificity 1 -- if it declares a manufacturer restriction OR a
 * non-wildcard TAC prefix list. `["*"]` with no manufacturer restriction is the least specific
 * match there is: it is the only thing left standing once the brand and TAC-specific candidates are
 * exhausted.
 */
function specificity(service: CatalogueService): number {
  if (service.appliesToManufacturers !== undefined) return 1;
  return service.appliesToTacPrefixes.includes('*') ? 0 : 1;
}

/** Brand-specific first, then cheapest. Shared by `candidates` and `plan`'s failover ranking. */
function ranked(a: { service: CatalogueService }, b: { service: CatalogueService }): number {
  return specificity(b.service) - specificity(a.service) || a.service.costUsd - b.service.costUsd;
}

/** Failure reasons that never count against a supplier's breaker. See the comment in `runCall`. */
const OUR_OWN_REFUSALS: ReadonlySet<FailureReason> = new Set(['rate_limited', 'spend_cap_reached']);

/**
 * `PlannedCall.capabilities` is never empty in practice -- `plan()` never emits one, and `run()`
 * always seeds one -- but the type is a `readonly Capability[]`. A guard, not a non-null assertion.
 */
function firstCapability(capabilities: readonly Capability[]): Capability {
  const [capability] = capabilities;
  if (capability === undefined) throw new Error('PlannedCall has no capabilities');
  return capability;
}

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

export interface CallResult extends RouteResult {
  /** All the capabilities this single call answered, e.g. all four for an all-in-one service. */
  readonly capabilities: readonly Capability[];
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

  /**
   * Every enabled service, from every provider, that covers this device -- unfiltered by
   * capability. `manufacturer` is the TAC directory's answer, if any; `undefined` means unknown.
   */
  private servicesFor(
    tac: string,
    manufacturer: string | undefined,
  ): Array<{ provider: Provider; service: CatalogueService }> {
    const out: Array<{ provider: Provider; service: CatalogueService }> = [];
    for (const provider of this.options.providers) {
      for (const service of provider.catalogue()) {
        if (service.enabled && coversDevice(service, tac, manufacturer)) out.push({ provider, service });
      }
    }
    return out;
  }

  /** Ordered candidates: brand-specific first, then cheapest. Used by `POST /v1/capabilities`. */
  candidates(
    capability: Capability,
    tac: string,
    manufacturer?: string,
  ): Array<{ provider: Provider; service: CatalogueService }> {
    return this.servicesFor(tac, manufacturer)
      .filter((c) => c.service.capabilities.includes(capability))
      .sort(ranked);
  }

  /**
   * Greedy set cover: repeatedly take the service that answers the most still-uncovered requested
   * capabilities (ties: brand-specific, then cheaper). One Apple all-in-one then costs one order,
   * not four -- imei24 charges again for every repeat.
   */
  plan(
    capabilities: readonly Capability[],
    tac: string,
    manufacturer?: string,
  ): { calls: PlannedCall[]; uncovered: Capability[] } {
    const pool = this.servicesFor(tac, manufacturer);
    let remaining = [...new Set(capabilities)];
    const calls: PlannedCall[] = [];

    while (remaining.length > 0) {
      const scored = pool
        .map((c) => ({ ...c, covers: remaining.filter((cap) => c.service.capabilities.includes(cap)) }))
        .filter((c) => c.covers.length > 0)
        .sort((a, b) => b.covers.length - a.covers.length || ranked(a, b));
      const best = scored[0];
      if (best === undefined) break;

      // Failover candidates: other services that cover the SAME set, ranked.
      const callCandidates = pool
        .filter((c) => best.covers.every((cap) => c.service.capabilities.includes(cap)))
        .sort(ranked);
      calls.push({ capabilities: best.covers, candidates: callCandidates });
      remaining = remaining.filter((cap) => !best.covers.includes(cap));
    }

    return { calls, uncovered: remaining };
  }

  /** Thin wrapper: plan a single capability, then run it. */
  async run(args: {
    capability: Capability;
    tac: string;
    manufacturer?: string;
    imeiDigits: string;
    signal: AbortSignal;
  }): Promise<RouteResult> {
    const { calls } = this.plan([args.capability], args.tac, args.manufacturer);
    const call = calls[0] ?? { capabilities: [args.capability], candidates: [] };
    return this.runCall({ call, imeiDigits: args.imeiDigits, signal: args.signal });
  }

  async runCall(args: { call: PlannedCall; imeiDigits: string; signal: AbortSignal }): Promise<CallResult> {
    const now = this.options.now ?? (() => new Date());
    const candidates = args.call.candidates;
    // A `PlannedCall` always names at least one capability; this only guards the type.
    const capability = firstCapability(args.call.capabilities);

    if (candidates.length === 0) {
      return {
        capability,
        capabilities: args.call.capabilities,
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
      // The caller's budget is spent (or it hung up): do not start another leg -- and above all
      // do not write a provider_calls row for a purchase we are not going to make.
      if (args.signal.aborted) {
        last = { kind: 'failed', reason: 'timeout', detail: 'Not attempted: the time budget was spent.' };
        break;
      }
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
        capability,
        costUsd: candidate.service.costUsd,
      });

      const outcome = await this.execute(candidate, { capability, imeiDigits: args.imeiDigits, signal: args.signal }, attemptId);
      const finishedAt = now();

      // Three kinds of `failed` say nothing about the supplier's health, so they never count
      // toward opening its circuit:
      //
      // - `spend_cap_reached`: our own daily budget refused the call.
      // - `rate_limited`: our own cross-process lock was busy -- AND, deliberately, the same
      //   reason from the supplier side (an HTTP 429, or imei24's "APIKEY is working in other
      //   session"). Both mean "one job at a time", i.e. contention with our OWN other process,
      //   not an outage; opening the circuit on it would turn a busy afternoon into a cool-down
      //   of failed checks.
      // - anything after the caller's own signal aborted (client hang-up or the deep-check time
      //   budget): the failure is ours, not theirs.
      //
      // They stay `failed` outcomes -- no field, never a pass.
      if (outcome.kind === 'failed') {
        if (!OUR_OWN_REFUSALS.has(outcome.reason) && !args.signal.aborted) breaker.recordFailure();
      } else breaker.recordSuccess();

      const attempt: Attempt = {
        attemptId,
        providerId: candidate.provider.id,
        serviceId: candidate.service.serviceId,
        capability,
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

    return { capability, capabilities: args.call.capabilities, attempts, outcome: last, service: lastService };
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
