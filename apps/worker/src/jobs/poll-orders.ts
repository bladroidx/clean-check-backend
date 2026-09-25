import {
  assembleSection,
  coverageFor,
  type Metrics,
  type OrderRow,
  type Repositories,
} from '@imei-check/core';
import type { TacDirectory } from '@imei-check/identity';
import type { Provider } from '@imei-check/providers';

/**
 * Polls standard (non-express) supplier orders.
 *
 * Express services answer in seconds; standard ones take 2-24 hours. The webhook is the primary
 * path and this is the fallback, because a supplier's `feedback_url` delivery is a single HTTP
 * POST from someone else's infrastructure and a dropped one would otherwise leave a paid check
 * permanently `partial`.
 *
 * The two rules that keep this from becoming an expensive loop:
 *
 * - **Backoff is exponential and capped.** A supplier that is slow is not a supplier to ask
 *   sixty times an hour; most charge for `getimeiorder` on some plans.
 * - **An expired order is abandoned**, not polled forever, and its section is marked `unavailable`
 *   with reason `awaiting_provider_timed_out` so that outcome is honestly expressible.
 */

const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const BATCH = 25;

export interface PollDeps {
  readonly repos: Repositories;
  readonly providers: readonly Provider[];
  readonly tacDirectory: TacDirectory;
  readonly metrics: Metrics;
  readonly now?: () => Date;
  readonly log?: (event: Record<string, unknown>, message: string) => void;
}

export interface PollSummary {
  readonly polled: number;
  readonly answered: number;
  readonly abandoned: number;
  readonly stillPending: number;
}

export async function pollOrders(deps: PollDeps): Promise<PollSummary> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const due = await deps.repos.orders.duePolls(at, BATCH);

  let answered = 0;
  let abandoned = 0;
  let stillPending = 0;

  for (const order of due) {
    if (order.expiresAt <= at) {
      await abandon(deps, order, at);
      abandoned += 1;
      continue;
    }

    const provider = deps.providers.find((p) => p.id === order.providerId);
    // TEMPORARY (Task 3): `poll` now takes the service that placed the order, because the
    // lexicon it must use lives on the service, not on the provider's first-registered one.
    // Task 8 replaces this file with the settle pipeline; until then, look the service up by id
    // and abandon the order if it is not found rather than guessing which lexicon applies.
    const service = provider?.catalogue().find((s) => s.serviceId === order.serviceId);
    if (provider?.poll === undefined || service === undefined || order.orderReference === undefined) {
      await abandon(deps, order, at);
      abandoned += 1;
      continue;
    }

    const outcome = await provider.poll(order.orderReference, service, AbortSignal.timeout(30_000));

    if (outcome.kind === 'pending') {
      const attempts = order.attempts + 1;
      await deps.repos.orders.update(order.id, {
        attempts,
        nextPollAt: new Date(at.getTime() + backoffFor(attempts)),
      });
      stillPending += 1;
      continue;
    }

    if (outcome.kind === 'failed') {
      // A transport failure is not an answer. Retry with backoff rather than settling the section
      // as unavailable -- the order is still open at the supplier and still paid for.
      const attempts = order.attempts + 1;
      await deps.repos.orders.update(order.id, {
        attempts,
        nextPollAt: new Date(at.getTime() + backoffFor(attempts)),
      });
      stillPending += 1;
      continue;
    }

    const section = assembleSection({
      capability: order.capability,
      outcome,
      coverage: coverageFor(order.capability, deps.tacDirectory),
      checkedAt: at,
      onLexiconMiss: (miss) => {
        deps.metrics.lexiconMiss.inc({ capability: miss.capability, service_id: miss.serviceId });
      },
    });

    await deps.repos.checks.putSection({
      checkId: order.checkId,
      capability: order.capability,
      outcome: section.outcome,
      section,
    });
    deps.metrics.sectionOutcome.inc({
      capability: order.capability,
      outcome: section.outcome,
      reason: section.reason ?? 'none',
    });

    await deps.repos.orders.update(order.id, {
      status: outcome.kind === 'answered' ? 'answered' : 'rejected',
      settledAt: at,
    });

    await completeIfDone(deps, order, at);
    answered += 1;
  }

  return { polled: due.length, answered, abandoned, stillPending };
}

/**
 * Gives up and says so in the report.
 *
 * The order timed out: the supplier never answered. `unavailable(awaiting_provider_timed_out)` is
 * the honest outcome -- we never obtained an answer, so nothing is claimed.
 */
async function abandon(deps: PollDeps, order: OrderRow, at: Date): Promise<void> {
  const section = assembleSection({
    capability: order.capability,
    outcome: { kind: 'failed', reason: 'timeout', detail: 'The supplier never returned a result.' },
    coverage: coverageFor(order.capability, deps.tacDirectory),
    checkedAt: at,
  });

  await deps.repos.checks.putSection({
    checkId: order.checkId,
    capability: order.capability,
    outcome: section.outcome,
    section,
  });
  await deps.repos.orders.update(order.id, { status: 'abandoned', settledAt: at });
  deps.metrics.sectionOutcome.inc({
    capability: order.capability,
    outcome: 'unavailable',
    reason: 'awaiting_provider_timed_out',
  });
  deps.log?.({ order_id: order.id, check_id: order.checkId }, 'order abandoned');
  await completeIfDone(deps, order, at);
}

async function completeIfDone(deps: PollDeps, order: OrderRow, at: Date): Promise<void> {
  const open = await deps.repos.orders.openForCheck(order.checkId);
  if (open.length === 0) {
    await deps.repos.checks.update(order.checkId, { status: 'complete', completedAt: at });
  }
}

export function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}
