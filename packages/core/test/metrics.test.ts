import { describe, expect, it } from 'vitest';
import { Metrics } from '../src/metrics.js';

/**
 * Metric names and labels are a contract with the dashboards and alerts, not an implementation
 * detail: renaming one silently blinds whatever was watching it. These tests pin the two that
 * predict failures unique to this service.
 */

describe('metrics', () => {
  it('exposes the format-drift alarm with the labels an alert needs', async () => {
    const metrics = new Metrics(false);
    metrics.lexiconMiss.inc({ capability: 'blacklist.gsma', service_id: '12' });

    const rendered = await metrics.render();
    expect(rendered).toContain('imei_lexicon_miss_total');
    expect(rendered).toContain('capability="blacklist.gsma"');
    expect(rendered).toContain('service_id="12"');
  });

  /** Money we spent and did not charge for. Invisible in revenue; this is where a margin dies. */
  it('exposes absorbed provider cost', async () => {
    const metrics = new Metrics(false);
    metrics.absorbedCostUsd.inc({ provider_id: 'alpha', reason: 'failover_leg' }, 0.12);
    expect(await metrics.render()).toContain('imei_absorbed_cost_usd_total');
  });

  it('exposes the whole signal set a release depends on', async () => {
    const metrics = new Metrics(false);
    metrics.sectionOutcome.inc({ capability: 'blacklist.gsma', outcome: 'pass', reason: 'none' });
    metrics.cacheHit.inc({ capability: 'blacklist.gsma', result: 'hit' });
    metrics.providerCall.inc({ provider_id: 'alpha', capability: 'blacklist.gsma', kind: 'answered' });
    metrics.providerLatency.observe({ provider_id: 'alpha', capability: 'blacklist.gsma' }, 0.5);
    metrics.circuitState.set({ provider_id: 'alpha' }, 0);

    const rendered = await metrics.render();
    for (const name of [
      'imei_section_outcome_total',
      'imei_cache_total',
      'imei_provider_call_total',
      'imei_provider_latency_seconds',
      'imei_provider_circuit_open',
    ]) {
      expect(rendered, `${name} is missing`).toContain(name);
    }
  });

  /**
   * Label cardinality is a correctness question here, not a cost one: a label carrying an IMEI,
   * a check id or a tenant-supplied string would either leak or explode the series count.
   */
  it('carries no high-cardinality or identifying label', async () => {
    const metrics = new Metrics(false);
    metrics.sectionOutcome.inc({ capability: 'blacklist.gsma', outcome: 'pass', reason: 'none' });
    const rendered = await metrics.render();
    expect(rendered).not.toMatch(/imei=/);
    expect(rendered).not.toMatch(/check_id=/);
    expect(rendered).not.toMatch(/\b\d{15}\b/);
  });

  it('collects default process metrics when asked', async () => {
    const metrics = new Metrics(true);
    expect(await metrics.render()).toContain('process_cpu_user_seconds_total');
  });
});
