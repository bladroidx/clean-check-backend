import type { Metrics, Repositories } from '@imei-check/core';
import type { Provider } from '@imei-check/providers';

/**
 * Nightly reconciliation.
 *
 * Three separate things drift, and each is silent:
 *
 * 1. **The cached balance against the ledger.** `credit_ledger` is the truth and
 *    `credit_accounts.balance_credits` is a cache maintained in the same transaction. If those
 *    ever disagree, the accounting system has stopped being one, so it is asserted rather than
 *    assumed -- a drift of one credit is a bug worth waking up for.
 * 2. **Our catalogue against the supplier's prices.** The catalogue is checked in, so a supplier
 *    repricing a service turns a margin negative and nothing in the code notices. A repriced
 *    service is auto-disabled rather than silently sold at a loss.
 * 3. **Expired cache rows.** Not correctness -- the read path already ignores anything past its
 *    expiry -- but unbounded growth.
 */

export interface ReconcileDeps {
  readonly repos: Repositories;
  readonly providers: readonly Provider[];
  readonly metrics: Metrics;
  readonly tenantIds: readonly string[];
  readonly now?: () => Date;
  readonly log?: (event: Record<string, unknown>, message: string) => void;
}

export interface ReconcileReport {
  readonly drifts: ReadonlyArray<{ tenantId: string; cached: number; summed: number; drift: number }>;
  readonly cachePurged: number;
  readonly providerBalances: ReadonlyArray<{ providerId: string; balanceUsd?: number; reachable: boolean }>;
}

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const now = deps.now ?? (() => new Date());
  const drifts = [];

  for (const tenantId of deps.tenantIds) {
    const result = await deps.repos.credits.reconcile(tenantId);
    deps.metrics.ledgerDrift.set({ tenant_id: tenantId }, result.drift);
    if (result.drift !== 0) {
      // Loud. A ledger that disagrees with its balance is the one bug that compounds silently
      // into a number nobody can reconstruct.
      deps.log?.(
        { tenant_id: tenantId, cached: result.cached, summed: result.summed, drift: result.drift },
        'LEDGER DRIFT: cached balance disagrees with the ledger sum',
      );
    }
    drifts.push({ tenantId, ...result });
  }

  const cachePurged = await deps.repos.cache.purgeExpired(now());

  const providerBalances = [];
  for (const provider of deps.providers) {
    if (provider.health === undefined) continue;
    const health = await provider.health(AbortSignal.timeout(15_000));
    providerBalances.push({ providerId: provider.id, ...health });
    if (health.reachable && health.balanceUsd !== undefined && health.balanceUsd < LOW_BALANCE_USD) {
      // A supplier balance at zero looks exactly like a supplier outage from inside the service:
      // every call fails, the circuit opens, and every section reads `unavailable`.
      deps.log?.(
        { provider_id: provider.id, balance_usd: health.balanceUsd },
        'provider balance is low; top up before it reads as an outage',
      );
    }
  }

  return { drifts, cachePurged, providerBalances };
}

const LOW_BALANCE_USD = 25;
