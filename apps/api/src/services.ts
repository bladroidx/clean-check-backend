import type { Capability } from '@imei-check/contract';
import { BreakerRegistry, Router, type Provider } from '@imei-check/providers';
import { FieldCache } from '@imei-check/core';
import {
  ConcurrencyGate,
  LIMITS,
  MAX_CONCURRENT_PAID_CHECKS,
  TokenBucketLimiter,
} from './abuse/ratelimit.js';
import type { Metrics } from '@imei-check/core';
import type { Repositories } from '@imei-check/core';

/**
 * Everything the routes need, assembled once.
 *
 * A single explicit object rather than a pile of Fastify decorators, so that a test can build the
 * whole service graph with in-memory repositories and fake providers in four lines -- and so that
 * nothing acquires an ambient dependency on a running database by accident.
 */

export interface AppServices {
  readonly repos: Repositories;
  readonly router: Router;
  readonly cache: FieldCache;
  readonly metrics: Metrics;
  readonly limiter: TokenBucketLimiter;
  readonly limits: typeof LIMITS;
  /** Depth, where `limiter` is rate. See the comment on `MAX_CONCURRENT_PAID_CHECKS`. */
  readonly concurrency: ConcurrencyGate;
  readonly maxConcurrentChecks: number;
  readonly breakers: BreakerRegistry;
  /** `SERVER_PEPPER`. The internal hash key, never returned and never per-tenant. */
  readonly pepper: Buffer;
  readonly defaultCapabilities: readonly Capability[];
  readonly providers: readonly Provider[];
}

/**
 * What a check runs when the caller does not name capabilities.
 *
 * Deliberately NOT every capability in the vocabulary: `lock.mdm` and `network.sold_by` are
 * niche, and silently spending a caller's credits on things they did not ask for is the kind of
 * default that ends up in a chargeback.
 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  'identity.model',
  'blacklist.gsma',
  'lock.carrier',
  'lock.activation',
];

export interface BuildServicesOptions {
  readonly repos: Repositories;
  readonly providers: readonly Provider[];
  readonly metrics: Metrics;
  readonly pepper: Buffer;
  readonly feedbackUrlFor?: (providerId: string) => string | undefined;
  readonly defaultCapabilities?: readonly Capability[];
  readonly now?: () => Date;
}

export function buildServices(options: BuildServicesOptions): AppServices {
  const breakers = new BreakerRegistry();
  const metrics = options.metrics;

  const router = new Router({
    providers: options.providers,
    breakers,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.feedbackUrlFor !== undefined ? { feedbackUrlFor: options.feedbackUrlFor } : {}),
    hooks: {
      // Written BEFORE the HTTP call. A timeout arriving after the supplier already debited us is
      // the common case; recording only on success puts the books permanently behind reality.
      async onCallStart(attempt) {
        await options.repos.providerCalls.start({
          id: attempt.attemptId,
          checkId: undefined,
          tenantId: 'pending',
          providerId: attempt.providerId,
          serviceId: attempt.serviceId,
          capability: attempt.capability,
          status: 'in_flight',
          providerCostUsd: attempt.costUsd,
          creditsCharged: 0,
          billable: true,
          latencyMs: undefined,
          errorCode: undefined,
          startedAt: new Date(),
          finishedAt: undefined,
        });
      },
      async onCallFinish(attempt) {
        await options.repos.providerCalls.finish(attempt.attemptId, {
          status: attempt.outcome.kind === 'answered' ? 'answered' : attempt.outcome.kind,
          latencyMs: attempt.latencyMs,
          billable: attempt.billable,
          providerCostUsd: attempt.costUsd,
          finishedAt: attempt.finishedAt,
          ...(attempt.outcome.kind === 'failed' || attempt.outcome.kind === 'rejected'
            ? { errorCode: attempt.outcome.reason }
            : {}),
        });
      },
    },
  });

  const services: AppServices = {
    repos: options.repos,
    router,
    cache: new FieldCache(options.repos.cache),
    metrics,
    limiter: new TokenBucketLimiter(),
    limits: LIMITS,
    concurrency: new ConcurrencyGate(),
    maxConcurrentChecks: MAX_CONCURRENT_PAID_CHECKS,
    breakers,
    pepper: options.pepper,
    defaultCapabilities: options.defaultCapabilities ?? DEFAULT_CAPABILITIES,
    providers: options.providers,
  };

  return services;
}

/** Keeps the circuit gauge honest without a timer: refreshed whenever metrics are scraped. */
export function refreshCircuitGauge(services: AppServices): void {
  for (const breaker of services.breakers.all()) {
    services.metrics.circuitState.set(
      { provider_id: breaker.providerId },
      breaker.state() === 'open' ? 1 : 0,
    );
  }
}
