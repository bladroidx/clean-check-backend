import type { Metrics, Repositories } from '@imei-check/core';
import type { Provider } from '@imei-check/providers';
import type { Log } from './reconcile-balance.js';

/**
 * The catalogue drift job ADR-0002 calls mandatory: compare every enabled service's checked-in
 * `cost_usd` with the supplier's LIVE price list, and stop buying anything that got dearer.
 *
 * Why disable rather than just alert: the spend cap sums the catalogue price. Once the live price
 * is higher, "$10/day" means "N calls/day at the old price", and real spend is unbounded by it.
 * The only purchase that keeps the cap honest is no purchase, until a human reprices the YAML.
 *
 * - price went UP, or the service is MISSING from the list -> override row (disabled) + error log.
 * - price went DOWN -> warning only. We overstate spend, which is the safe direction, but the
 *   catalogue is still wrong and should be fixed.
 * - the list could not be read at all -> error log, nothing disabled. A format change on their
 *   side must not switch the whole catalogue off (Provider.servicePrices returns undefined, never
 *   an empty map, for exactly this reason).
 *
 * Re-enabling is deliberately manual: `npm run service:override -- clear <provider> <service>`
 * after the YAML has been updated and deployed. An automatic re-enable would let a price that
 * flaps back for a day re-arm the under-counting cap without anyone having looked.
 */

export interface CatalogueDriftOptions {
  readonly providers: readonly Provider[];
  readonly repos: Pick<Repositories, 'serviceOverrides'>;
  readonly metrics: Metrics;
  readonly log: Log;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export interface DriftFinding {
  readonly providerId: string;
  readonly serviceId: string;
  readonly direction: 'up' | 'down' | 'missing';
  readonly cataloguePriceUsd: number;
  readonly livePriceUsd: number | undefined;
}

/** Below a hundredth of a cent the difference is rounding, not a reprice. */
const EPSILON_USD = 0.00005;

export async function detectCatalogueDrift(options: CatalogueDriftOptions): Promise<{
  readonly findings: readonly DriftFinding[];
  /** False when any provider's price list could not be read. */
  readonly complete: boolean;
}> {
  const now = (options.now ?? (() => new Date()))();
  const findings: DriftFinding[] = [];
  let complete = true;

  for (const provider of options.providers) {
    if (provider.servicePrices === undefined) continue;
    const providerId = provider.id;
    const prices = await provider.servicePrices(AbortSignal.timeout(options.timeoutMs ?? 30_000));
    if (prices === undefined) {
      complete = false;
      options.log('error', { provider_id: providerId }, 'catalogue drift: could not read the supplier price list');
      continue;
    }

    for (const service of provider.catalogue()) {
      if (!service.enabled) continue;
      const live = prices.get(service.serviceId);
      const base = { providerId, serviceId: service.serviceId, cataloguePriceUsd: service.costUsd };

      if (live === undefined) {
        findings.push({ ...base, direction: 'missing', livePriceUsd: undefined });
        await options.repos.serviceOverrides.disable({
          ...base,
          reason: 'missing_from_supplier_list',
          livePriceUsd: undefined,
          detectedAt: now,
        });
        options.metrics.catalogueDrift.inc({ provider_id: providerId, service_id: service.serviceId, direction: 'missing' });
        options.log(
          'error',
          { provider_id: providerId, service_id: service.serviceId, catalogue_usd: service.costUsd },
          'service missing from the supplier price list: disabled until a human reviews it',
        );
      } else if (live > service.costUsd + EPSILON_USD) {
        findings.push({ ...base, direction: 'up', livePriceUsd: live });
        await options.repos.serviceOverrides.disable({
          ...base,
          reason: 'price_increased',
          livePriceUsd: live,
          detectedAt: now,
        });
        options.metrics.catalogueDrift.inc({ provider_id: providerId, service_id: service.serviceId, direction: 'up' });
        options.log(
          'error',
          { provider_id: providerId, service_id: service.serviceId, catalogue_usd: service.costUsd, live_usd: live },
          'supplier raised a price above the catalogue: service disabled until the catalogue is repriced',
        );
      } else if (live < service.costUsd - EPSILON_USD) {
        findings.push({ ...base, direction: 'down', livePriceUsd: live });
        options.metrics.catalogueDrift.inc({ provider_id: providerId, service_id: service.serviceId, direction: 'down' });
        options.log(
          'warn',
          { provider_id: providerId, service_id: service.serviceId, catalogue_usd: service.costUsd, live_usd: live },
          'supplier price is below the catalogue: spend is overstated (safe), update the catalogue',
        );
      }
    }
  }

  // The gauge is the standing signal: non-zero until someone reprices and clears the override.
  const overrides = await options.repos.serviceOverrides.list();
  for (const provider of options.providers) {
    options.metrics.servicesDisabled.set(
      { provider_id: provider.id },
      overrides.filter((o) => o.providerId === provider.id).length,
    );
  }

  return { findings, complete };
}
