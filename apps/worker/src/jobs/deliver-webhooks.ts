import { createHmac } from 'node:crypto';
import type { Repositories } from '@imei-check/core';

/**
 * Outbound webhook delivery.
 *
 * We sign the exact bytes we send with the endpoint's secret, and we send the timestamp inside the
 * signed material. Signing only the body lets an attacker who captures one delivery replay it
 * forever; a timestamp in the signature gives the receiver something to reject on.
 *
 * The payload is the check report, which by construction contains no raw IMEI -- only the masked
 * form and the tenant-salted hash. Nothing is added to it here, precisely so that stays true.
 */

const BATCH = 50;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export interface DeliverDeps {
  readonly repos: Repositories;
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (event: Record<string, unknown>, message: string) => void;
}

export interface DeliverSummary {
  readonly attempted: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

export async function deliverWebhooks(deps: DeliverDeps): Promise<DeliverSummary> {
  const now = deps.now ?? (() => new Date());
  const send = deps.fetchImpl ?? fetch;
  const at = now();
  const due = await deps.repos.webhooks.due(at, BATCH);

  let delivered = 0;
  let retrying = 0;
  let failed = 0;

  for (const delivery of due) {
    const endpoint = await deps.repos.webhooks.endpointById(delivery.endpointId);

    if (endpoint === undefined || !endpoint.active) {
      // Deleted or deactivated after the delivery was queued. Dropping it is correct; retrying
      // forever against a row that no longer exists -- or that the tenant has turned off -- is not.
      await deps.repos.webhooks.markDelivery(delivery.id, { status: 'failed' });
      failed += 1;
      continue;
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(at.getTime() / 1000);
    const attempts = delivery.attempts + 1;

    let status = 0;
    try {
      const response = await send(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-imei-check-event': delivery.event,
          'x-imei-check-timestamp': String(timestamp),
          'x-imei-check-signature': signPayload(endpoint.secret, timestamp, body),
          'user-agent': 'imei-check-webhooks/1',
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
    } catch {
      status = 0;
    }

    if (status >= 200 && status < 300) {
      await deps.repos.webhooks.markDelivery(delivery.id, {
        status: 'delivered',
        attempts,
        lastStatus: status,
      });
      delivered += 1;
      continue;
    }

    if (attempts >= MAX_ATTEMPTS) {
      await deps.repos.webhooks.markDelivery(delivery.id, {
        status: 'failed',
        attempts,
        lastStatus: status,
      });
      deps.log?.({ delivery_id: delivery.id, status }, 'webhook delivery exhausted');
      failed += 1;
      continue;
    }

    await deps.repos.webhooks.markDelivery(delivery.id, {
      status: 'pending',
      attempts,
      lastStatus: status,
      nextRetryAt: new Date(at.getTime() + backoffFor(attempts)),
    });
    retrying += 1;
  }

  return { attempted: due.length, delivered, retrying, failed };
}

export function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}
