import type { Capability } from '@imei-check/contract';
import { BreakerRegistry, Router, type Provider } from '@imei-check/providers';
import { FieldCache, GuardedProvider, type ImeiCipher } from '@imei-check/core';
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
  /** ADR-0007: the keyring every check's IMEI is encrypted under before it is ever persisted. */
  readonly cipher: ImeiCipher;
  /** What `POST /v1/checks` answers when the caller names nothing. Offline only. */
  readonly defaultCapabilities: readonly Capability[];
  /** What `POST /v1/deep_checks` buys when the caller names nothing. */
  readonly deepDefaultCapabilities: readonly Capability[];
  /**
   * The deep route's TOTAL budget, from request start, before handing off to
   * `GET /v1/deep_checks/:id`. Must stay below every caller's timeout (config caps it at 12 s).
   */
  readonly deepWaitMs: number;
  /** Pause between polls inside the wait window. */
  readonly pollIntervalMs: number;
  /**
   * Every provider wrapped in `GuardedProvider` -- the same instances the router uses, so the wait
   * window's polls take the same one-job-at-a-time lock as the order that placed them.
   */
  readonly providers: readonly Provider[];
}

/**
 * What the free check answers when the caller does not name capabilities: everything it CAN
 * answer, which is the offline TAC lookup and nothing else.
 */
export const FREE_DEFAULT_CAPABILITIES: readonly Capability[] = ['identity.model'];

/**
 * What a deep check buys when the caller does not name capabilities.
 *
 * Deliberately the one question a buyer always has and nothing more: every capability is a
 * separate supplier charge, and silently spending money on locks and warranty nobody asked about is
 * the kind of default that only ever gets noticed on the invoice.
 */
export const DEEP_DEFAULT_CAPABILITIES: readonly Capability[] = ['blacklist.gsma'];

export interface BuildServicesOptions {
  readonly repos: Repositories;
  readonly providers: readonly Provider[];
  readonly metrics: Metrics;
  readonly pepper: Buffer;
  readonly cipher: ImeiCipher;
  readonly feedbackUrlFor?: (providerId: string) => string | undefined;
  readonly defaultCapabilities?: readonly Capability[];
  readonly now?: () => Date;
  /** `DEEP_CHECK_WAIT_MS`. Default 10 000. */
  readonly deepWaitMs?: number;
  /** Default 1 000. */
  readonly pollIntervalMs?: number;
  /** `IMEI24_DAILY_SPEND_USD`, applied per provider. Default 10. */
  readonly dailySpendUsd?: number;
  /**
   * How long a call may wait for the supplier's one-job lock. Default half the wait window (at
   * least 1 s), so a busy lock cannot by itself eat the whole budget of a deep check.
   */
  readonly lockWaitMs?: number;
}

export function buildServices(options: BuildServicesOptions): AppServices {
  const breakers = new BreakerRegistry();
  const metrics = options.metrics;
  const deepWaitMs = options.deepWaitMs ?? 10_000;
  const lockWaitMs = options.lockWaitMs ?? Math.max(1_000, Math.floor(deepWaitMs / 2));
  const dailySpendUsd = options.dailySpendUsd ?? 10;

  // One wrapper per provider, shared by the router (placing orders) and the wait window (polling
  // them), so both honour the same lock and the same daily cap.
  const providers = options.providers.map(
    (p) =>
      new GuardedProvider(p, {
        lock: options.repos.locks,
        lockWaitMs,
        dailySpendUsd,
        costSince: (id, since) => options.repos.providerCalls.costSinceForProvider(id, since),
        ...(options.now !== undefined ? { now: options.now } : {}),
      }),
  );

  const router = new Router({
    providers,
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
    cipher: options.cipher,
    defaultCapabilities: options.defaultCapabilities ?? FREE_DEFAULT_CAPABILITIES,
    deepDefaultCapabilities: DEEP_DEFAULT_CAPABILITIES,
    deepWaitMs,
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
    providers,
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
