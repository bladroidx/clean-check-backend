import { deriveVerdict } from '@imei-check/contract';
import type { TacDirectory } from '@imei-check/identity';
import type { Provider } from '@imei-check/providers';
import { FieldCache } from '../cache/store.js';
import type { OrderRow, Repositories } from '../db/types.js';
import type { Metrics } from '../metrics.js';
import { coverageFor } from '../report/coverage.js';
import { assembleSection } from '../report/assemble.js';

/**
 * Settles standard (non-express) supplier orders -- shared by the API and the worker.
 *
 * Express services answer in seconds; standard ones take 2-24 hours. The webhook is the primary
 * path and this is the fallback, because a supplier's `feedback_url` delivery is a single HTTP
 * POST from someone else's infrastructure and a dropped one would otherwise leave a paid check
 * permanently `partial`. The API's own 10 s wait window (Task 9) and the worker's poll loop are
 * the same operation on different clocks, so they share this one implementation rather than
 * risking the two drifting apart on backoff, abandonment or field-cache writes.
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

export interface SettleDeps {
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

/** Settles exactly the given orders -- the API's wait window calls this with the orders it just placed. */
export async function pollOrders(deps: SettleDeps, orders: readonly OrderRow[]): Promise<PollSummary> {
  const now = deps.now ?? (() => new Date());
  const at = now();

  let answered = 0;
  let abandoned = 0;
  let stillPending = 0;

  for (const order of orders) {
    if (order.expiresAt <= at) {
      await abandon(deps, order, at);
      abandoned += 1;
      continue;
    }

    const provider = deps.providers.find((p) => p.id === order.providerId);
    // The lexicon a poll must use lives on the SERVICE that placed the order, not on whichever
    // service the provider happens to register first, so the order's own `serviceId` decides it.
    // If the service has since dropped out of the catalogue, or the provider cannot poll at all,
    // or there is no supplier-side reference to poll, the order cannot be settled: abandon it
    // rather than guessing which lexicon applies.
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

    // The synchronous path caches whatever it learned even from a section that did not pass; the
    // async path never did, which meant a repeat check re-bought an answer we already had. Same
    // write here, keyed on the check's own tenant-facing IMEI hash.
    if (outcome.kind === 'answered') {
      await new FieldCache(deps.repos.cache).write({
        imeiHash: order.imeiHash,
        fields: outcome.fields,
        coverage: coverageFor(order.capability, deps.tacDirectory),
        providerId: order.providerId,
        checkedAt: at,
      });
    }

    await deps.repos.orders.update(order.id, {
      status: outcome.kind === 'answered' ? 'answered' : 'rejected',
      settledAt: at,
    });

    await completeIfDone(deps, order, at);
    answered += 1;
  }

  return { polled: orders.length, answered, abandoned, stillPending };
}

/** Worker entry point: settles whatever is due right now. */
export async function pollDueOrders(deps: SettleDeps): Promise<PollSummary> {
  const now = deps.now ?? (() => new Date());
  const due = await deps.repos.orders.duePolls(now(), BATCH);
  return pollOrders(deps, due);
}

/**
 * Gives up and says so in the report.
 *
 * The order timed out: the supplier never answered. `unavailable(awaiting_provider_timed_out)` is
 * the honest outcome -- we never obtained an answer, so nothing is claimed.
 */
async function abandon(deps: SettleDeps, order: OrderRow, at: Date): Promise<void> {
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

/**
 * Marks the check complete once no order is left open for it, and recomputes the verdict from
 * every stored section rather than trusting whatever it was set to before this order settled --
 * an async section landing is exactly the case where the synchronous verdict was provisional.
 */
async function completeIfDone(deps: SettleDeps, order: OrderRow, at: Date): Promise<void> {
  const open = await deps.repos.orders.openForCheck(order.checkId);
  if (open.length === 0) {
    const sections = await deps.repos.checks.sections(order.checkId);
    const { verdict } = deriveVerdict(sections.map((s) => s.section));
    await deps.repos.checks.update(order.checkId, { status: 'complete', verdict, completedAt: at });
  }
}

export function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}
