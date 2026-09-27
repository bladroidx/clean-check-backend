import type { Metrics, Repositories } from '@imei-check/core';
import type { Provider } from '@imei-check/providers';

/**
 * Reconciles the supplier's REAL prepaid balance against our own books.
 *
 * Every `provider_calls.provider_cost_usd` is the catalogue price we checked in, so the daily spend
 * cap and every dashboard agree with each other by construction -- and would go on agreeing after
 * imei24 silently tripled a price. The balance is the one number the supplier controls. If it fell
 * by more than we recorded spending over the same window, something is being spent that our books
 * do not see: this job is what turns that from "discovered at the next top-up" into an alert.
 *
 * It only ever reads and records; it never blocks a purchase. The drift job does that, on the
 * narrower and more certain signal of a changed price (catalogue-drift.ts).
 */

export type Log = (level: 'info' | 'warn' | 'error', event: Record<string, unknown>, message: string) => void;

export interface ReconcileBalanceOptions {
  readonly providers: readonly Provider[];
  readonly repos: Pick<Repositories, 'balances' | 'providerCalls'>;
  readonly metrics: Metrics;
  readonly log: Log;
  readonly now?: () => Date;
  /** Relative slack on recorded spend before a larger balance drop is called drift. Default 0.10. */
  readonly tolerance?: number;
  /** Absolute slack, for rounding and tiny windows. Default $0.50. */
  readonly floorUsd?: number;
  /** Alert when the balance lasts fewer days than this at the trailing burn rate. Default 3. */
  readonly runwayAlertDays?: number;
  readonly timeoutMs?: number;
}

export type ReconcileStatus =
  | 'unreachable'
  | 'no_balance'
  | 'first_snapshot'
  | 'top_up'
  | 'ok'
  | 'drift';

export interface ReconcileResult {
  readonly providerId: string;
  readonly status: ReconcileStatus;
  readonly balanceUsd?: number;
  readonly observedDropUsd?: number;
  readonly recordedUsd?: number;
  readonly runwayDays?: number;
}

const DAY_MS = 86_400_000;

/** Four decimal places, as provider_cost_usd stores it; anything finer is float noise. */
const round = (usd: number): number => Math.round(usd * 10_000) / 10_000;

export async function reconcileBalances(options: ReconcileBalanceOptions): Promise<{
  readonly results: readonly ReconcileResult[];
  /** False when any provider's balance could not be read -- the job did not do its job. */
  readonly complete: boolean;
}> {
  const clock = options.now ?? (() => new Date());
  const tolerance = options.tolerance ?? 0.1;
  const floorUsd = options.floorUsd ?? 0.5;
  const runwayAlertDays = options.runwayAlertDays ?? 3;
  const results: ReconcileResult[] = [];

  for (const provider of options.providers) {
    if (provider.health === undefined) continue;
    const providerId = provider.id;
    const health = await provider.health(AbortSignal.timeout(options.timeoutMs ?? 15_000));

    if (!health.reachable) {
      options.log('warn', { provider_id: providerId }, 'balance reconcile: supplier unreachable');
      results.push({ providerId, status: 'unreachable' });
      continue;
    }
    if (health.balanceUsd === undefined) {
      // Includes "our own lock was busy" -- the next tick is a free retry.
      options.log('warn', { provider_id: providerId }, 'balance reconcile: no balance in the reply');
      results.push({ providerId, status: 'no_balance' });
      continue;
    }

    // Read the clock AFTER the balance: health() may wait for the one-job lock and the HTTP call,
    // and spend charged during that wait belongs inside this window, not the next.
    const now = clock();
    const balanceUsd = health.balanceUsd;
    const previous = await options.repos.balances.latest(providerId);
    await options.repos.balances.record({ providerId, balanceUsd, takenAt: now });
    options.metrics.providerBalanceUsd.set({ provider_id: providerId }, balanceUsd);

    const runwayDays = await runway(options, providerId, balanceUsd, now);
    if (runwayDays !== undefined) {
      options.metrics.providerRunwayDays.set({ provider_id: providerId }, runwayDays);
      if (runwayDays < runwayAlertDays) {
        options.log(
          'error',
          { provider_id: providerId, balance_usd: balanceUsd, runway_days: round(runwayDays) },
          'supplier balance runs out in under the alert window at the current burn rate: top up',
        );
      }
    }

    if (previous === undefined) {
      options.log('info', { provider_id: providerId, balance_usd: balanceUsd }, 'first balance snapshot');
      results.push({ providerId, status: 'first_snapshot', balanceUsd, ...(runwayDays !== undefined ? { runwayDays } : {}) });
      continue;
    }

    const observedDropUsd = round(previous.balanceUsd - balanceUsd);
    const recordedUsd = round(
      await options.repos.providerCalls.costBetweenForProvider(providerId, previous.takenAt, now),
    );
    const common = {
      providerId,
      balanceUsd,
      observedDropUsd,
      recordedUsd,
      ...(runwayDays !== undefined ? { runwayDays } : {}),
    };

    // Known blind spot: the drop is NET of any top-up in the window. A top-up smaller than the
    // spend reads as a smaller drop (possibly `ok`); only a net rise is visible as one. Top up
    // right after a reconcile tick to keep the windows either side of it clean.
    if (observedDropUsd < 0) {
      // A top-up. Its size is unknown, so it hides whatever was spent in the same window: say so
      // rather than pretending the window reconciled.
      options.log(
        'info',
        { provider_id: providerId, balance_usd: balanceUsd, rise_usd: -observedDropUsd, recorded_usd: recordedUsd },
        'balance rose (top-up); this window cannot be reconciled',
      );
      results.push({ ...common, status: 'top_up' });
      continue;
    }

    if (observedDropUsd > recordedUsd * (1 + tolerance) + floorUsd) {
      options.metrics.balanceDrift.inc({ provider_id: providerId });
      options.log(
        'error',
        {
          provider_id: providerId,
          observed_drop_usd: observedDropUsd,
          recorded_usd: recordedUsd,
          since: previous.takenAt.toISOString(),
        },
        'supplier balance fell by more than our recorded spend: a silent reprice or unrecorded spend',
      );
      results.push({ ...common, status: 'drift' });
      continue;
    }

    results.push({ ...common, status: 'ok' });
  }

  return { results, complete: results.every((r) => r.status !== 'unreachable' && r.status !== 'no_balance') };
}

/** Days of balance left at the trailing 3-day average recorded spend; undefined with no spend. */
async function runway(
  options: ReconcileBalanceOptions,
  providerId: string,
  balanceUsd: number,
  now: Date,
): Promise<number | undefined> {
  const spent = await options.repos.providerCalls.costBetweenForProvider(
    providerId,
    new Date(now.getTime() - 3 * DAY_MS),
    now,
  );
  const perDay = spent / 3;
  return perDay > 0 ? balanceUsd / perDay : undefined;
}
