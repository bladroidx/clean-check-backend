import { deriveVerdict, unavailable, type Capability, type SectionResult } from '@imei-check/contract';
import type { TacDirectory } from '@imei-check/identity';
import { capabilityOf, type FieldValue, type Provider, type ProviderOutcome } from '@imei-check/providers';
import { FieldCache } from '../cache/store.js';
import type { OrderRow, Repositories } from '../db/types.js';
import type { Metrics } from '../metrics.js';
import { coverageFor } from '../report/coverage.js';
import { assembleSection, deriveWarrantyStatus } from '../report/assemble.js';

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

export interface PollOptions {
  /**
   * The caller's budget. The API's wait window passes its deep-check budget here, so a slow
   * supplier or a busy lock cannot hold the request past it; a pass stops as soon as it aborts.
   */
  readonly signal?: AbortSignal;
  /**
   * Whether a still-pending (or transport-failed) poll pushes `attempts`/`nextPollAt` along the
   * backoff. The worker's schedule: true. The API's wait window polls every second for ten
   * seconds, and letting those polls advance the shared backoff would push the worker's next poll
   * out by an hour -- so it passes false and leaves the schedule exactly as it found it.
   */
  readonly advanceBackoff?: boolean;
}

/**
 * Settles exactly the given orders -- the API's wait window calls this with the orders it just placed.
 *
 * One supplier order can back several rows: one per capability it answers, plus a row per other
 * check that attached to it. Each distinct `(providerId, orderReference)` is polled ONCE per pass
 * and the outcome is applied to every row sharing it -- polling it N times would take the
 * supplier's one-job lock N times for the same answer.
 */
export async function pollOrders(
  deps: SettleDeps,
  orders: readonly OrderRow[],
  options: PollOptions = {},
): Promise<PollSummary> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const advanceBackoff = options.advanceBackoff ?? true;

  let answered = 0;
  let abandoned = 0;
  let stillPending = 0;

  const groups = new Map<string, OrderRow[]>();
  for (const order of orders) {
    if (order.expiresAt <= at) {
      await abandon(deps, order, at, 'The supplier never returned a result.');
      abandoned += 1;
      continue;
    }
    // No supplier reference means nothing to poll: a group of its own, abandoned below.
    const key =
      order.orderReference === undefined
        ? `row\u0000${order.id}`
        : `ref\u0000${order.providerId}\u0000${order.orderReference}`;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }

  for (const rows of groups.values()) {
    const head = rows[0];
    if (head === undefined) continue;

    if (options.signal?.aborted === true) {
      // Out of budget: leave the rest exactly as they are for the worker.
      stillPending += rows.length;
      continue;
    }

    const provider = deps.providers.find((p) => p.id === head.providerId);
    // The lexicon a poll must use lives on the SERVICE that placed the order, not on whichever
    // service the provider happens to register first, so the order's own `serviceId` decides it.
    // If the service has since dropped out of the catalogue, or the provider cannot poll at all,
    // or there is no supplier-side reference to poll, the order cannot be settled: abandon it
    // rather than guessing which lexicon applies.
    const service = provider?.catalogue().find((s) => s.serviceId === head.serviceId);
    if (provider?.poll === undefined || service === undefined || head.orderReference === undefined) {
      for (const order of rows) await abandon(deps, order, at, 'The order can no longer be polled.');
      abandoned += rows.length;
      continue;
    }

    const timeout = AbortSignal.timeout(30_000);
    const signal = options.signal !== undefined ? AbortSignal.any([options.signal, timeout]) : timeout;
    const outcome = await provider.poll(head.orderReference, service, signal);

    if (outcome.kind === 'pending' || outcome.kind === 'failed') {
      // A transport failure is not an answer. Retry with backoff rather than settling the section
      // as unavailable -- the order is still open at the supplier and still paid for.
      if (advanceBackoff) {
        for (const order of rows) {
          const attempts = order.attempts + 1;
          await deps.repos.orders.update(order.id, {
            attempts,
            nextPollAt: new Date(at.getTime() + backoffFor(attempts)),
          });
        }
      }
      stillPending += rows.length;
      continue;
    }

    // The synchronous path caches whatever it learned even from a section that did not pass; so
    // does this one, ONCE per supplier order, each field under its own capability's coverage --
    // one write per row under the row's capability would let the last row's coverage win for
    // every field. Keyed on the internal cache-key hash; a pre-Task-9 row has no stored hash
    // (`imeiHash === ''`), and writing under an empty key would make every such order share one
    // cache row, so those skip the cache write and settle their sections normally.
    const imeiHash = rows.find((r) => r.imeiHash !== '')?.imeiHash;
    if (outcome.kind === 'answered' && imeiHash !== undefined) {
      const byCapability = new Map<Capability, FieldValue[]>();
      for (const field of outcome.fields) {
        const owner = capabilityOf(field.field);
        byCapability.set(owner, [...(byCapability.get(owner) ?? []), field]);
      }
      const cache = new FieldCache(deps.repos.cache);
      for (const [owner, fields] of byCapability) {
        await cache.write({
          imeiHash,
          fields,
          coverage: coverageFor(owner, deps.tacDirectory),
          providerId: head.providerId,
          checkedAt: at,
        });
      }
    }

    for (const order of rows) {
      await settleOrder(deps, order, outcome, at);
      answered += 1;
    }
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
 * Settles ONE order row with a supplier's final answer (answered or rejected): its section, the
 * section derived from it, the order row and the check. Shared by the poll path above and the
 * inbound webhook route, so the two cannot drift on what "settled" means.
 */
export async function settleOrder(
  deps: SettleDeps,
  order: OrderRow,
  outcome: Extract<ProviderOutcome, { kind: 'answered' | 'rejected' }>,
  at: Date,
): Promise<void> {
  const section = assembleSection({
    capability: order.capability,
    outcome,
    coverage: coverageFor(order.capability, deps.tacDirectory),
    checkedAt: at,
    onLexiconMiss: (miss) => {
      deps.metrics.lexiconMiss.inc({ capability: miss.capability, service_id: miss.serviceId });
    },
  });
  await putSection(deps, order.checkId, section);

  await deps.repos.orders.update(order.id, {
    status: outcome.kind === 'answered' ? 'answered' : 'rejected',
    settledAt: at,
  });

  if (order.capability === 'warranty.purchase_date') {
    const purchase =
      outcome.kind === 'answered'
        ? outcome.fields.find((f) => f.field === 'warranty.purchase_date')
        : undefined;
    await rederiveWarranty(deps, order.checkId, at, purchase?.value);
  }

  await refreshCheck(deps, order.checkId, at);
}

/**
 * Gives up and says so in the report.
 *
 * We never obtained an answer: `unavailable(awaiting_provider_timed_out)` is the honest outcome
 * (spec section 5, R14) -- not `provider_timeout`, which would claim the supplier timed out on a
 * request, when what happened is that we stopped waiting for an order.
 */
async function abandon(deps: SettleDeps, order: OrderRow, at: Date, detail: string): Promise<void> {
  await putSection(
    deps,
    order.checkId,
    unavailable({
      capability: order.capability,
      reason: 'awaiting_provider_timed_out',
      detail,
      coverage: coverageFor(order.capability, deps.tacDirectory),
      checkedAt: at,
    }),
  );
  await deps.repos.orders.update(order.id, { status: 'abandoned', settledAt: at });
  if (order.capability === 'warranty.purchase_date') {
    await rederiveWarranty(deps, order.checkId, at, undefined, true);
  }
  deps.log?.({ order_id: order.id, check_id: order.checkId }, 'order abandoned');
  await refreshCheck(deps, order.checkId, at);
}

async function putSection(deps: SettleDeps, checkId: string, section: SectionResult): Promise<void> {
  await deps.repos.checks.putSection({
    checkId,
    capability: section.capability,
    outcome: section.outcome,
    section,
  });
  deps.metrics.sectionOutcome.inc({
    capability: section.capability,
    outcome: section.outcome,
    reason: section.reason ?? 'none',
  });
}

/**
 * `warranty.status` is derived from `warranty.purchase_date` (ADR-0004), and on the deep route the
 * purchase date is always an async order -- so at placement the derived section can only say
 * `inconclusive(awaiting_provider)`. This is where it is re-derived once the date lands (final
 * review F4). Only a section still waiting is touched: a check that never asked for warranty
 * status gains nothing, and a settled one is not rewritten.
 */
async function rederiveWarranty(
  deps: SettleDeps,
  checkId: string,
  at: Date,
  purchaseDateIso: string | undefined,
  abandoned = false,
): Promise<void> {
  const stored = (await deps.repos.checks.sections(checkId)).find((s) => s.capability === 'warranty.status');
  if (stored === undefined) return;
  if (stored.section.outcome !== 'inconclusive' || stored.section.reason !== 'awaiting_provider') return;

  const coverage = coverageFor('warranty.status', deps.tacDirectory);
  const section =
    purchaseDateIso !== undefined
      ? deriveWarrantyStatus({ purchaseDateIso, coverage, checkedAt: at })
      : unavailable({
          capability: 'warranty.status',
          checkedAt: at,
          coverage,
          reason: abandoned ? 'awaiting_provider_timed_out' : 'capability_not_supported_for_device',
          detail: abandoned
            ? 'Warranty status is derived from a purchase date, and the supplier never returned one.'
            : 'Warranty status is derived from a purchase date, and no purchase date was ' +
              'available for this device.',
        });
  await putSection(deps, checkId, section);
}

/**
 * Recomputes the verdict from every stored section on EVERY settle, not just the last one: a
 * `fail` landing while another order is still open must turn the summary red at once rather than
 * sit under the provisional amber (final review F5). The check is marked complete once no order is
 * left open for it.
 */
async function refreshCheck(deps: SettleDeps, checkId: string, at: Date): Promise<void> {
  const sections = await deps.repos.checks.sections(checkId);
  const { verdict } = deriveVerdict(sections.map((s) => s.section));
  const open = await deps.repos.orders.openForCheck(checkId);
  await deps.repos.checks.update(
    checkId,
    open.length === 0 ? { status: 'complete', verdict, completedAt: at } : { verdict },
  );
}

export function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}
