import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Metrics.
 *
 * Two of these predict failures unique to this service and exist before anything more
 * conventional:
 *
 * - **`imei_lexicon_miss_total`** is the format-drift alarm. A supplier rewording "Clean" makes
 *   every affected section go amber; without this counter the first signal would be a support
 *   ticket weeks later, and by then the fix is retroactive.
 * - **`imei_absorbed_cost_usd_total`** is money we spent and did not charge for -- failover legs
 *   and our own lexicon gaps. It is invisible in revenue and it is exactly where a margin goes
 *   negative quietly.
 *
 * Label cardinality is kept deliberately low: a label per IMEI, per check or per tenant would
 * either leak or explode the series count. `capability` and `provider_id` are bounded sets.
 */

export class Metrics {
  readonly registry = new Registry();

  readonly lexiconMiss = new Counter({
    name: 'imei_lexicon_miss_total',
    help: 'Recognised label carried an unrecognised value. The format-drift alarm.',
    labelNames: ['capability', 'service_id'] as const,
    registers: [this.registry],
  });

  readonly absorbedCostUsd = new Counter({
    name: 'imei_absorbed_cost_usd_total',
    help: 'Provider spend we did not pass on: failover legs and our own lexicon gaps.',
    labelNames: ['provider_id', 'reason'] as const,
    registers: [this.registry],
  });

  readonly sectionOutcome = new Counter({
    name: 'imei_section_outcome_total',
    help: 'Sections produced, by capability and arm.',
    labelNames: ['capability', 'outcome', 'reason'] as const,
    registers: [this.registry],
  });

  readonly cacheHit = new Counter({
    name: 'imei_cache_total',
    help: 'Field cache reads. Hit rate is essentially the gross margin.',
    labelNames: ['capability', 'result'] as const,
    registers: [this.registry],
  });

  readonly providerCall = new Counter({
    name: 'imei_provider_call_total',
    help: 'Provider calls by outcome kind.',
    labelNames: ['provider_id', 'capability', 'kind'] as const,
    registers: [this.registry],
  });

  readonly providerLatency = new Histogram({
    name: 'imei_provider_latency_seconds',
    help: 'Provider call latency.',
    labelNames: ['provider_id', 'capability'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30],
    registers: [this.registry],
  });

  readonly creditsCharged = new Counter({
    name: 'imei_credits_charged_total',
    help: 'Credits actually charged, by charge decision.',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly circuitState = new Gauge({
    name: 'imei_provider_circuit_open',
    help: '1 when a provider circuit is open.',
    labelNames: ['provider_id'] as const,
    registers: [this.registry],
  });

  readonly abuseLadder = new Counter({
    name: 'imei_abuse_restriction_total',
    help: 'Enumeration ladder transitions.',
    labelNames: ['level'] as const,
    registers: [this.registry],
  });

  readonly ledgerDrift = new Gauge({
    name: 'imei_ledger_drift_credits',
    help: 'Cached balance minus summed ledger. Must be zero.',
    labelNames: ['tenant_id'] as const,
    registers: [this.registry],
  });

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
