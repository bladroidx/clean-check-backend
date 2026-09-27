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

  readonly circuitState = new Gauge({
    name: 'imei_provider_circuit_open',
    help: '1 when a provider circuit is open.',
    labelNames: ['provider_id'] as const,
    registers: [this.registry],
  });

  /**
   * The supplier's REAL prepaid balance, from `accountinfo`. Everything else we record about spend
   * is priced from our own catalogue; this is the one number the supplier controls.
   */
  readonly providerBalanceUsd = new Gauge({
    name: 'imei_provider_balance_usd',
    help: "Supplier's real prepaid balance at the last reconcile.",
    labelNames: ['provider_id'] as const,
    registers: [this.registry],
  });

  /** Days of balance left at the trailing 3-day burn rate. Alert well before it reaches 0. */
  readonly providerRunwayDays = new Gauge({
    name: 'imei_provider_balance_runway_days',
    help: 'Balance divided by the trailing 3-day average daily recorded spend.',
    labelNames: ['provider_id'] as const,
    registers: [this.registry],
  });

  /**
   * The balance fell by more than our books say we spent: a silent reprice, or spend we did not
   * record. Every increment is an alert.
   */
  readonly balanceDrift = new Counter({
    name: 'imei_provider_balance_drift_total',
    help: 'Reconcile windows where the real balance fell more than recorded spend (+ tolerance).',
    labelNames: ['provider_id'] as const,
    registers: [this.registry],
  });

  /** A catalogue service's live price no longer matches what we checked in. */
  readonly catalogueDrift = new Counter({
    name: 'imei_catalogue_drift_total',
    help: 'Services whose live supplier price differs from the catalogue, by direction.',
    labelNames: ['provider_id', 'service_id', 'direction'] as const,
    registers: [this.registry],
  });

  /** Services currently switched off by the drift job. Non-zero means someone must reprice. */
  readonly servicesDisabled = new Gauge({
    name: 'imei_services_disabled',
    help: 'Catalogue services switched off by the drift job, awaiting a human reprice.',
    labelNames: ['provider_id'] as const,
    registers: [this.registry],
  });

  /**
   * Unix seconds of each worker job's last SUCCESSFUL run. The staleness alert is
   * `time() - imei_job_last_success_timestamp_seconds > 2 * interval`: a job that silently stopped
   * is the failure none of the counters above can show.
   */
  readonly jobLastSuccess = new Gauge({
    name: 'imei_job_last_success_timestamp_seconds',
    help: 'Unix time of the last successful run of each worker job.',
    labelNames: ['job'] as const,
    registers: [this.registry],
  });

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
